using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace EdgeLink
{
    // stdout is reserved exclusively for Chromium Native Messaging frames.
    internal static class Program
    {
        private const int MaximumRequestBytes = 4 * 1024 * 1024;
        private const int MaximumResponseBytes = 1024 * 1024 - 1;
        private const int ProxyPort = 17890;
        private const int ControllerPort = 17990;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumRequestBytes, RecursionLimit = 100 };
        private static readonly string BaseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        private static readonly string DataDirectory = Path.Combine(BaseDirectory, "data");
        private static readonly string ConfigurationPath = Path.Combine(DataDirectory, "config.json");
        private static readonly string CorePath = Path.Combine(BaseDirectory, "bin", "mihomo.exe");
        private static readonly string BundledGeodataDirectory = Path.Combine(BaseDirectory, "geodata");
        private static readonly object LogLock = new object();
        private static readonly Queue<string> Logs = new Queue<string>();
        private static int LogCharacters;
        private static readonly HttpClient Controller = CreateClient();
        private static Mutex InstanceMutex;
        private static bool OwnsMutex;
        private static Process Core;
        private static string Secret;
        private static string CoreVersion;
        private static IntPtr NativeJob;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const long MaximumLogFileBytes = 256 * 1024;

        private static int Main(string[] args)
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            try
            {
                InstanceMutex = new Mutex(false, "Local\\EdgeLinkNativeHost_" + Hash(BaseDirectory.ToLowerInvariant()).Substring(0, 24));
                AcquireInstance();
                while (true)
                {
                    byte[] header = new byte[4];
                    if (!ReadFully(input, header, 0, 4, true)) break;
                    uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
                    if (length == 0 || length > MaximumRequestBytes)
                    {
                        WriteFrame(output, Result(null, false, null, "原生消息长度无效，连接已关闭。"));
                        break;
                    }
                    byte[] frame = new byte[length];
                    if (!ReadFully(input, frame, 0, frame.Length, false)) break;
                    object requestId = null;
                    object result;
                    try
                    {
                        Dictionary<string, object> request = AsDictionary(Json.DeserializeObject(new UTF8Encoding(false, true).GetString(frame)), "消息必须是 JSON 对象。");
                        request.TryGetValue("id", out requestId);
                        if (requestId != null && !(requestId is string) && !(requestId is int) && !(requestId is long) && !(requestId is double)) requestId = null;
                        if (requestId is string && ((string)requestId).Length > 256)
                        {
                            requestId = null;
                            throw new HostException("请求 id 不得超过 256 个字符。");
                        }
                        string command = GetString(request, "command", true);
                        object rawPayload;
                        request.TryGetValue("payload", out rawPayload);
                        Dictionary<string, object> payload = rawPayload == null ? new Dictionary<string, object>() : AsDictionary(rawPayload, "payload 必须是 JSON 对象。");
                        if (!AcquireInstance()) throw new HostException("另一个 EdgeLink 连接正在使用本机内核。请关闭其他 EdgeLink 页面或浏览器，再重试连接。");
                        result = Result(requestId, true, Execute(command, payload), null);
                    }
                    catch (HostException exception)
                    {
                        AddLog("[EdgeLink] " + Redact(exception.Message));
                        result = Result(requestId, false, null, Redact(exception.Message));
                    }
                    catch (Exception exception)
                    {
                        Console.Error.WriteLine("EdgeLink host: " + exception.GetType().Name);
                        AddLog("[EdgeLink] 宿主异常：" + exception.GetType().Name);
                        result = Result(requestId, false, null, "本机服务未能完成操作。请检查内核文件和配置后重试。");
                    }
                    WriteFrame(output, result);
                }
                return 0;
            }
            catch (IOException) { return 0; }
            catch (Exception exception)
            {
                Console.Error.WriteLine("EdgeLink host stopped: " + exception.GetType().Name);
                AddLog("[EdgeLink] 宿主已停止：" + exception.GetType().Name);
                return 1;
            }
            finally
            {
                StopCore();
                CloseNativeJob();
                Controller.Dispose();
                if (OwnsMutex && InstanceMutex != null)
                {
                    try { InstanceMutex.ReleaseMutex(); } catch (ApplicationException) { }
                }
                if (InstanceMutex != null) InstanceMutex.Dispose();
            }
        }

        private static bool AcquireInstance()
        {
            if (OwnsMutex) return true;
            try { OwnsMutex = InstanceMutex.WaitOne(0); }
            catch (AbandonedMutexException) { OwnsMutex = true; }
            return OwnsMutex;
        }

        private static HttpClient CreateClient()
        {
            HttpClientHandler handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
            HttpClient client = new HttpClient(handler);
            client.Timeout = Timeout.InfiniteTimeSpan;
            return client;
        }

        private static object Execute(string command, Dictionary<string, object> payload)
        {
            switch (command)
            {
                case "start": StartCore(); return Status();
                case "status": return Status();
                case "shutdown": StopCore(); return Status();
                case "request": return ControllerRequest(payload);
                case "applyConfig": return ApplyConfiguration(payload);
                case "readLogs":
                    lock (LogLock) return new Dictionary<string, object> { { "lines", Logs.ToArray() } };
                default: throw new HostException("不支持的本机服务命令。");
            }
        }

        private static object Status()
        {
            return new Dictionary<string, object> {
                { "running", CoreAlive() }, { "version", CoreVersion },
                { "proxyPort", ProxyPort }, { "controllerPort", ControllerPort }
            };
        }

        private static bool CoreAlive()
        {
            if (Core == null) return false;
            try { return !Core.HasExited; }
            catch (InvalidOperationException) { return false; }
        }

        private static void InitializeResources()
        {
            Directory.CreateDirectory(DataDirectory);
            Directory.CreateDirectory(Path.Combine(DataDirectory, "providers"));
            string secretPath = Path.Combine(DataDirectory, "secret.txt");
            if (File.Exists(secretPath)) Secret = File.ReadAllText(secretPath, Encoding.UTF8).Trim();
            if (Secret == null || !Regex.IsMatch(Secret, "^[a-f0-9]{64}$"))
            {
                byte[] random = new byte[32];
                using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
                StringBuilder builder = new StringBuilder(64);
                foreach (byte value in random) builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                Secret = builder.ToString();
                AtomicWrite(secretPath, Secret);
            }
            PrepareBundledGeodata();
        }

        private static Dictionary<string, object> LoadSavedConfiguration()
        {
            Dictionary<string, object> configuration;
            if (File.Exists(ConfigurationPath))
            {
                FileInfo file = new FileInfo(ConfigurationPath);
                if (file.Length > MaximumRequestBytes) throw new HostException("本机配置超过 4 MiB，请重新导入较小的订阅。");
                try { configuration = AsDictionary(Json.DeserializeObject(File.ReadAllText(ConfigurationPath, Encoding.UTF8)), "本机配置无效。"); }
                catch (HostException) { throw; }
                catch { throw new HostException("本机配置无法读取，请重新导入配置。"); }
            }
            else configuration = SeedConfiguration();
            return configuration;
        }

        private static void PrepareBundledGeodata()
        {
            try
            {
                Directory.CreateDirectory(DataDirectory);
                List<string> existingDatabases = new List<string>();
                foreach (string path in Directory.GetFiles(DataDirectory, "*", SearchOption.TopDirectoryOnly))
                {
                    string name = Path.GetFileName(path);
                    if (String.Equals(name, "Country.mmdb", StringComparison.OrdinalIgnoreCase) ||
                        String.Equals(name, "geoip.db", StringComparison.OrdinalIgnoreCase) ||
                        String.Equals(name, "geoip.metadb", StringComparison.OrdinalIgnoreCase)) existingDatabases.Add(path);
                }
                string bundledDatabase = Path.Combine(BundledGeodataDirectory, "Country.mmdb");
                if (existingDatabases.Count == 0)
                {
                    RequireBundledDatabase(bundledDatabase);
                    AtomicCopyResource(bundledDatabase, CheckedDataPath("Country.mmdb"));
                }
                else foreach (string path in existingDatabases)
                {
                    if (HasMaxMindMetadata(path)) continue;
                    RequireBundledDatabase(bundledDatabase);
                    AtomicCopyResource(bundledDatabase, CheckedDataPath(path));
                    AddLog("[EdgeLink] 不完整的 MMDB 缓存已用内置完整数据库修复。");
                }
                foreach (string name in new string[] { "GeoIP.dat", "GeoSite.dat" })
                {
                    string destination = CheckedDataPath(name);
                    if (File.Exists(destination) && HasCompleteDatRecords(destination)) continue;
                    string source = Path.Combine(BundledGeodataDirectory, name);
                    if (!File.Exists(source) || !HasCompleteDatRecords(source))
                        throw new HostException("安装包缺少完整的内置 Geo 数据。请补齐 native/geodata 资源或重新安装扩展后重试；当前配置保持不变。");
                    AtomicCopyResource(source, destination);
                }
            }
            catch (HostException) { throw; }
            catch (IOException) { throw new HostException("内置 Geo 数据无法准备。请检查安装包完整性和 data 目录的写入权限，关闭并重新连接扩展后重试。"); }
            catch (UnauthorizedAccessException) { throw new HostException("没有权限准备内置 Geo 数据。请检查 data 目录的写入权限后重试。"); }
        }

        private static void RequireBundledDatabase(string path)
        {
            if (!File.Exists(path) || !HasMaxMindMetadata(path))
                throw new HostException("内置 Country.mmdb 缺失或不完整，无法离线校验 GEOIP 规则。请补齐 native/geodata 资源或重新安装扩展后重试；当前配置保持不变。");
        }

        private static bool HasCompleteDatRecords(string path)
        {
            // GeoIPList and GeoSiteList are protobuf repeated message field 1.
            // Walking entry boundaries detects an interrupted download without
            // replacing complete custom databases or decoding their contents.
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                int records = 0;
                while (file.Position < file.Length)
                {
                    if (file.ReadByte() != 0x0A) return false;
                    uint length = 0;
                    bool terminated = false;
                    for (int shift = 0; shift <= 28; shift += 7)
                    {
                        int value = file.ReadByte();
                        if (value < 0 || (shift == 28 && value > 15)) return false;
                        length |= (uint)(value & 0x7F) << shift;
                        if ((value & 0x80) == 0) { terminated = true; break; }
                    }
                    if (!terminated || length == 0 || length > file.Length - file.Position) return false;
                    file.Seek(length, SeekOrigin.Current);
                    records++;
                }
                return records > 0;
            }
        }

        private static bool HasMaxMindMetadata(string path)
        {
            // MaxMind DB metadata, including its marker, is limited to the last
            // 128 KiB by the official file format specification.
            byte[] marker = { 0xAB, 0xCD, 0xEF, (byte)'M', (byte)'a', (byte)'x', (byte)'M', (byte)'i', (byte)'n', (byte)'d', (byte)'.', (byte)'c', (byte)'o', (byte)'m' };
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (file.Length < marker.Length) return false;
                int length = (int)Math.Min(file.Length, 128 * 1024);
                byte[] tail = new byte[length];
                file.Seek(-length, SeekOrigin.End);
                int read = 0;
                while (read < length)
                {
                    int count = file.Read(tail, read, length - read);
                    if (count == 0) return false;
                    read += count;
                }
                for (int index = tail.Length - marker.Length; index >= 0; index--)
                {
                    bool match = true;
                    for (int offset = 0; offset < marker.Length; offset++)
                        if (tail[index + offset] != marker[offset]) { match = false; break; }
                    if (match) return true;
                }
                return false;
            }
        }

        private static void AtomicCopyResource(string source, string destination)
        {
            destination = CheckedDataPath(destination);
            string temporary = CheckedDataPath("." + Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.Copy(source, temporary, false);
                if (File.Exists(destination)) File.Replace(temporary, destination, null);
                else File.Move(temporary, destination);
            }
            finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
        }

        private static Dictionary<string, object> SeedConfiguration()
        {
            return new Dictionary<string, object> {
                { "mode", "rule" }, { "log-level", "info" },
                { "proxies", new object[0] },
                { "proxy-groups", new object[] { new Dictionary<string, object> {
                    { "name", "PROXY" }, { "type", "select" }, { "proxies", new object[] { "DIRECT" } }
                } } },
                { "rules", new object[] { "MATCH,PROXY" } }
            };
        }

        private static void StartCore()
        {
            if (CoreAlive()) return;
            if (!File.Exists(CorePath)) throw new HostException("未找到独立 Mihomo 内核。请先运行安装脚本，确认 native/bin/mihomo.exe 已存在。");
            InitializeResources();
            Dictionary<string, object> configuration = LoadSavedConfiguration();
            StartColdConfiguration(Json.Serialize(SanitizeConfiguration(configuration)));
        }

        private static void StartPreparedCore()
        {
            if (CoreAlive()) return;
            DisposeExitedCore();
            if (!File.Exists(CorePath)) throw new HostException("未找到独立 Mihomo 内核。请先运行安装脚本，确认 native/bin/mihomo.exe 已存在。");
            CheckPorts();
            PrepareBundledGeodata();
            Process process = new Process();
            process.StartInfo = CoreProcessInfo(ConfigurationPath, false);
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { if (eventArgs.Data != null) AddLog(eventArgs.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { if (eventArgs.Data != null) AddLog(eventArgs.Data); };
            try
            {
                EnsureNativeJob();
                if (!process.Start()) throw new HostException("无法启动独立 Mihomo 内核。");
                Core = process;
                BindOwnedProcess(process);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                Stopwatch watch = Stopwatch.StartNew();
                while (watch.ElapsedMilliseconds < 10000)
                {
                    if (!CoreAlive()) throw new HostException("Mihomo 内核启动后退出，请查看日志并检查配置。");
                    try
                    {
                        Dictionary<string, object> version = AsDictionary(SendController("GET", "/version", null, 1000, false), "内核版本响应无效。");
                        object value;
                        CoreVersion = version.TryGetValue("version", out value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
                        if (!CoreAlive()) throw new HostException("Mihomo 内核已退出，请查看日志并重试。");
                        AddLog("[EdgeLink] 独立内核已启动，仅监听 127.0.0.1:" + ProxyPort + "。");
                        return;
                    }
                    catch (HostException) { }
                    Thread.Sleep(150);
                }
                throw new HostException("Mihomo 控制器未能在 10 秒内就绪，请检查配置和本机端口。");
            }
            catch (HostException) { StopCore(); throw; }
            catch { StopCore(); process.Dispose(); throw new HostException("独立内核启动失败，请确认下载的内核适合这台 Windows 电脑。"); }
        }

        private static void StartColdConfiguration(string text)
        {
            CheckPorts();
            bool hadConfiguration = File.Exists(ConfigurationPath);
            string backup = CheckedDataPath("config.rollback-" + Guid.NewGuid().ToString("N") + ".json");
            bool keepBackup = false;
            bool committed = false;
            try
            {
                if (hadConfiguration) File.Copy(ConfigurationPath, backup, false);
                AtomicWrite(ConfigurationPath, text);
                committed = true;
                StartPreparedCore();
            }
            catch
            {
                StopCore();
                if (committed)
                {
                    try
                    {
                        if (hadConfiguration) AtomicCopyResource(backup, ConfigurationPath);
                        else if (File.Exists(ConfigurationPath)) File.Delete(ConfigurationPath);
                    }
                    catch
                    {
                        keepBackup = hadConfiguration;
                        throw new HostException("内核启动失败，配置回滚被本机文件权限阻止。原配置已保留在 data 的 config.rollback 备份中，请关闭扩展并恢复备份后重试。");
                    }
                }
                throw;
            }
            finally
            {
                if (!keepBackup) try { if (File.Exists(backup)) File.Delete(backup); } catch (IOException) { }
            }
        }

        private static ProcessStartInfo CoreProcessInfo(string configurationPath, bool validate)
        {
            ProcessStartInfo information = new ProcessStartInfo {
                FileName = CorePath,
                Arguments = (validate ? "-t " : "") + "-d " + Quote(DataDirectory) + " -f " + Quote(configurationPath),
                WorkingDirectory = BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            // Subscriptions cannot inherit a wider filesystem allowlist from a
            // user's shell. Mihomo's own path checks stay restricted to -d data.
            information.EnvironmentVariables["SKIP_SAFE_PATH_CHECK"] = "false";
            information.EnvironmentVariables["SAFE_PATHS"] = "";
            return information;
        }

        private static void EnsureNativeJob()
        {
            if (NativeJob != IntPtr.Zero) return;
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new HostException("无法创建 Windows 内核退出保护（错误 " + Marshal.GetLastWin32Error() + "）。请重试本机服务。");
            JobExtendedLimitInformation information = new JobExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int size = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    int error = Marshal.GetLastWin32Error();
                    CloseHandle(job);
                    throw new HostException("Windows 内核退出保护初始化失败（错误 " + error + "）。本次不会启动内核。");
                }
                NativeJob = job;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static void BindOwnedProcess(Process process)
        {
            // Only processes created by this host are assigned. The job handle is
            // non-inheritable, so forced host termination closes it and kills Mihomo.
            EnsureNativeJob();
            if (AssignProcessToJobObject(NativeJob, process.Handle)) return;
            int error = Marshal.GetLastWin32Error();
            try { if (!process.HasExited) { process.Kill(); process.WaitForExit(3000); } }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            throw new HostException("无法绑定 Windows 内核退出保护（错误 " + error + "）。已停止本次创建的内核，请重新连接本机服务。");
        }

        private static void CloseNativeJob()
        {
            if (NativeJob == IntPtr.Zero) return;
            CloseHandle(NativeJob);
            NativeJob = IntPtr.Zero;
        }

        private static void CheckPorts()
        {
            TcpListener proxy = new TcpListener(IPAddress.Loopback, ProxyPort);
            TcpListener controller = new TcpListener(IPAddress.Loopback, ControllerPort);
            try
            {
                proxy.Server.ExclusiveAddressUse = true;
                controller.Server.ExclusiveAddressUse = true;
                proxy.Start();
                controller.Start();
            }
            catch (SocketException)
            {
                throw new HostException("本机端口 17890 或 17990 已被其他程序占用。请关闭占用端口的程序后重试；EdgeLink 不会连接其他代理内核。");
            }
            finally { proxy.Stop(); controller.Stop(); }
        }

        private static void StopCore()
        {
            Process process = Core;
            Core = null;
            CoreVersion = null;
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                    process.WaitForExit(3000);
                    AddLog("[EdgeLink] 独立内核已停止。");
                }
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            finally { process.Dispose(); }
        }

        private static void DisposeExitedCore()
        {
            if (Core != null)
            {
                try { Core.Dispose(); } catch { }
                Core = null;
            }
            CoreVersion = null;
        }

        private static object ControllerRequest(Dictionary<string, object> payload)
        {
            if (!CoreAlive()) throw new HostException("独立内核尚未启动，请先连接本机服务。");
            string method = GetString(payload, "method", true).ToUpperInvariant();
            string path = GetString(payload, "path", true);
            object body;
            payload.TryGetValue("body", out body);
            int timeout = ReadTimeout(payload);
            ValidateControllerRequest(method, path, ref body);
            object result = SendController(method, path, body, timeout, path == "/traffic");
            if (method == "PATCH" && path == "/configs") PersistRuntimeConfiguration(AsDictionary(body, "配置变更无效。"));
            return RemoveSensitiveValues(result);
        }

        private static int ReadTimeout(Dictionary<string, object> payload)
        {
            object timeout;
            if (!payload.TryGetValue("timeoutMs", out timeout)) return 10000;
            int result;
            if (!Int32.TryParse(Convert.ToString(timeout, CultureInfo.InvariantCulture), out result) || result < 500 || result > 30000)
                throw new HostException("请求超时必须在 500 至 30000 毫秒之间。");
            return result;
        }

        private static void ValidateControllerRequest(string method, string path, ref object body)
        {
            if (path.Length > 2048 || !path.StartsWith("/", StringComparison.Ordinal) || path.Contains("\\") || path.Contains("#") || path.Contains("\r") || path.Contains("\n"))
                throw new HostException("控制器路径无效。");
            string[] getPaths = { "/version", "/configs", "/proxies", "/providers/proxies", "/rules", "/connections", "/traffic" };
            if (method == "GET")
            {
                if (body != null) throw new HostException("GET 请求不能携带请求体。");
                foreach (string allowed in getPaths) if (path == allowed) return;
                if (IsSingleSegment(path, "/proxies/") || IsSingleSegment(path, "/providers/proxies/")) return;
                if (ValidDelayPath(path)) return;
                if (IsSingleSegmentSuffix(path, "/providers/proxies/", "/healthcheck")) return;
            }
            else if (method == "PATCH" && path == "/configs")
            {
                Dictionary<string, object> patch = AsDictionary(body, "运行模式变更必须是 JSON 对象。");
                if (patch.Count == 0) throw new HostException("请指定运行模式或日志级别。");
                Dictionary<string, object> safe = new Dictionary<string, object>();
                foreach (KeyValuePair<string, object> pair in patch)
                {
                    string value = pair.Value as string;
                    if (pair.Key == "mode" && value != null && (value == "rule" || value == "global" || value == "direct")) safe.Add(pair.Key, value);
                    else if (pair.Key == "log-level" && value != null && (value == "silent" || value == "error" || value == "warning" || value == "info" || value == "debug")) safe.Add(pair.Key, value);
                    else throw new HostException("只允许修改 rule/global/direct 模式或有效日志级别。");
                }
                body = safe;
                return;
            }
            else if (method == "PUT" && IsSingleSegment(path, "/proxies/"))
            {
                Dictionary<string, object> selection = AsDictionary(body, "代理选择必须是 JSON 对象。");
                string name = GetString(selection, "name", true);
                if (selection.Count != 1 || name.Length > 512 || HasControls(name)) throw new HostException("代理选择无效。");
                body = new Dictionary<string, object> { { "name", name } };
                return;
            }
            else if (method == "PUT" && IsSingleSegment(path, "/providers/proxies/") && body == null) return;
            else if (method == "DELETE" && (path == "/connections" || IsSingleSegment(path, "/connections/")) && body == null) return;
            throw new HostException("此控制器操作未在允许列表中。订阅配置请通过导入功能应用。");
        }

        private static bool IsSingleSegment(string path, string prefix)
        {
            if (!path.StartsWith(prefix, StringComparison.Ordinal)) return false;
            string segment = path.Substring(prefix.Length);
            if (segment.Length == 0 || segment.Length > 1536 || segment.Contains("/") || segment.Contains("?") || segment.Contains("#")) return false;
            try
            {
                string decoded = Uri.UnescapeDataString(segment);
                if (HasControls(decoded) || decoded.Contains("\\") || decoded.Contains("?") || decoded.Contains("#")) return false;
                foreach (string part in decoded.Split('/')) if (part == "." || part == "..") return false;
                return !decoded.StartsWith("/", StringComparison.Ordinal);
            }
            catch { return false; }
        }

        private static bool IsSingleSegmentSuffix(string path, string prefix, string suffix)
        {
            return path.EndsWith(suffix, StringComparison.Ordinal) && IsSingleSegment(path.Substring(0, path.Length - suffix.Length), prefix);
        }

        private static bool ValidDelayPath(string path)
        {
            int queryIndex = path.IndexOf('?');
            if (queryIndex < 0 || !IsSingleSegmentSuffix(path.Substring(0, queryIndex), "/proxies/", "/delay")) return false;
            string query = path.Substring(queryIndex + 1);
            Dictionary<string, string> parameters = new Dictionary<string, string>();
            foreach (string entry in query.Split('&'))
            {
                int split = entry.IndexOf('=');
                if (split < 1) return false;
                string key = Uri.UnescapeDataString(entry.Substring(0, split));
                if (parameters.ContainsKey(key)) return false;
                parameters[key] = Uri.UnescapeDataString(entry.Substring(split + 1));
            }
            string url;
            string timeout;
            int timeoutValue;
            if (parameters.Count != 2 || !parameters.TryGetValue("url", out url) || !parameters.TryGetValue("timeout", out timeout)) return false;
            if (!Int32.TryParse(timeout, out timeoutValue) || timeoutValue < 100 || timeoutValue > 20000) return false;
            Uri target;
            return Uri.TryCreate(url, UriKind.Absolute, out target) &&
                (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps) &&
                target.Host.Length > 0 && target.UserInfo.Length == 0 && target.Fragment.Length == 0 && !HasControls(url);
        }

        private static bool HasControls(string value)
        {
            foreach (char character in value) if (Char.IsControl(character)) return true;
            return false;
        }

        private static object SendController(string method, string path, object body, int timeout, bool firstLine)
        {
            using (CancellationTokenSource cancellation = new CancellationTokenSource(timeout))
            using (HttpRequestMessage request = new HttpRequestMessage(new HttpMethod(method), "http://127.0.0.1:" + ControllerPort + path))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Secret);
                if (body != null) request.Content = new StringContent(Json.Serialize(body), Encoding.UTF8, "application/json");
                try
                {
                    using (HttpResponseMessage response = Controller.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token).GetAwaiter().GetResult())
                    {
                        int status = (int)response.StatusCode;
                        if (status >= 300 && status <= 399) throw new HostException("本机控制器返回了重定向，已拒绝请求。");
                        if (!response.IsSuccessStatusCode)
                            throw new HostException("本机控制器拒绝了操作（HTTP " + status + "）。请检查节点名称或订阅配置。");
                        if (response.StatusCode == HttpStatusCode.NoContent) return new Dictionary<string, object>();
                        using (Stream stream = response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
                        using (MemoryStream buffer = new MemoryStream())
                        {
                            byte[] chunk = new byte[8192];
                            bool finished = false;
                            while (!finished)
                            {
                                int count = stream.ReadAsync(chunk, 0, chunk.Length, cancellation.Token).GetAwaiter().GetResult();
                                if (count == 0) break;
                                if (firstLine)
                                {
                                    for (int index = 0; index < count; index++)
                                    {
                                        if (chunk[index] == 10) { count = index; finished = true; break; }
                                    }
                                }
                                if (buffer.Length + count > 900000) throw new HostException("控制器数据过大，无法通过浏览器原生消息传输。请减少订阅节点或连接数。");
                                buffer.Write(chunk, 0, count);
                            }
                            string text = Encoding.UTF8.GetString(buffer.ToArray()).Trim();
                            if (text.Length == 0) return new Dictionary<string, object>();
                            try { return Json.DeserializeObject(text); }
                            catch { throw new HostException("本机控制器返回了无效 JSON 数据。"); }
                        }
                    }
                }
                catch (HostException) { throw; }
                catch (OperationCanceledException) { throw new HostException("本机控制器请求超时，请稍后重试。"); }
                catch (HttpRequestException) { throw new HostException("无法连接本机控制器，内核可能已停止。"); }
                catch (IOException) { throw new HostException("本机控制器连接已中断，请重新启动内核。"); }
            }
        }

        private static object ApplyConfiguration(Dictionary<string, object> payload)
        {
            object raw;
            if (!payload.TryGetValue("config", out raw)) throw new HostException("缺少需要导入的配置。");
            if (raw is string)
            {
                try { raw = Json.DeserializeObject((string)raw); }
                catch { throw new HostException("请先在扩展中解析 YAML 或 JSON 配置后再导入。"); }
            }
            Dictionary<string, object> config = AsDictionary(raw, "配置必须是 JSON 对象。");
            InitializeResources();
            Dictionary<string, object> sanitized = SanitizeConfiguration(config);
            string text = Json.Serialize(sanitized);
            if (Encoding.UTF8.GetByteCount(text) > MaximumRequestBytes) throw new HostException("配置超过 4 MiB，请减少订阅内容后重试。");
            string candidate = Path.Combine(DataDirectory, "candidate-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(candidate, text, new UTF8Encoding(false));
                ValidateConfiguration(candidate);
                if (CoreAlive())
                {
                    SendController("PUT", "/configs?force=true", new Dictionary<string, object> { { "payload", text }, { "path", "" } }, 15000, false);
                    AtomicWrite(ConfigurationPath, text);
                }
                else StartColdConfiguration(text);
                AddLog("[EdgeLink] 订阅配置已验证并应用。");
                return new Dictionary<string, object> { { "applied", true }, { "proxyPort", ProxyPort }, { "controllerPort", ControllerPort } };
            }
            finally { try { if (File.Exists(candidate)) File.Delete(candidate); } catch (IOException) { } }
        }

        private static void ValidateConfiguration(string candidate)
        {
            if (!File.Exists(CorePath)) throw new HostException("未找到独立 Mihomo 内核，无法校验配置。请补齐内核文件后重试；当前配置保持不变。");
            PrepareBundledGeodata();
            EnsureNativeJob();
            using (Process validator = new Process())
            {
                validator.StartInfo = CoreProcessInfo(candidate, true);
                // Validation output can contain credentials. Only report its result.
                validator.OutputDataReceived += delegate { };
                validator.ErrorDataReceived += delegate { };
                try
                {
                    validator.Start();
                    BindOwnedProcess(validator);
                    validator.BeginOutputReadLine();
                    validator.BeginErrorReadLine();
                    if (!validator.WaitForExit(15000))
                    {
                        try { validator.Kill(); validator.WaitForExit(3000); } catch { }
                        throw new HostException("配置校验超过 15 秒。内置 Geo 数据已准备，配置可能仍需下载远程规则或 provider；请更新远程资源后重试。当前配置保持不变。");
                    }
                    if (validator.ExitCode != 0) throw new HostException("Mihomo 配置验证失败，请检查代理类型、规则、策略组和 Geo 资源；当前配置保持不变。");
                }
                catch (HostException) { throw; }
                catch { throw new HostException("无法运行配置验证，当前配置保持不变。"); }
            }
        }

        private static Dictionary<string, object> SanitizeConfiguration(Dictionary<string, object> input)
        {
            Dictionary<string, object> parsed = AsDictionary(Json.DeserializeObject(Json.Serialize(input)), "配置无效。");
            Dictionary<string, object> config = new Dictionary<string, object>();
            // JSON struct fields can match case-insensitively. Canonicalize root names
            // before stripping listeners, DNS listen, and provider filesystem paths.
            foreach (KeyValuePair<string, object> pair in parsed)
            {
                string key = pair.Key.ToLowerInvariant();
                if (config.ContainsKey(key)) throw new HostException("配置含有仅大小写不同的重复字段，请合并后重试。");
                config.Add(key, pair.Value);
            }
            string[] forbidden = {
                "port", "socks-port", "redir-port", "tproxy-port", "mixed-port", "listeners", "inbounds",
                "external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe",
                "external-controller-cors", "external-ui", "external-ui-name", "external-ui-url", "secret",
                "allow-lan", "bind-address", "authentication", "skip-auth-prefixes", "tun", "ebpf", "hosts-file",
                "ss-config", "vmess-config", "tuic-server", "tunnels", "tls", "external-doh-server", "iptables"
            };
            List<string> remove = new List<string>();
            foreach (string key in config.Keys)
                foreach (string blocked in forbidden)
                    if (String.Equals(key, blocked, StringComparison.OrdinalIgnoreCase)) { remove.Add(key); break; }
            foreach (string key in remove) config.Remove(key);
            config["mixed-port"] = ProxyPort;
            config["external-controller"] = "127.0.0.1:" + ControllerPort;
            config["secret"] = Secret;
            config["allow-lan"] = false;
            config["bind-address"] = "127.0.0.1";
            config["tun"] = new Dictionary<string, object> { { "enable", false } };
            object dns;
            if (config.TryGetValue("dns", out dns))
            {
                Dictionary<string, object> dnsConfig = AsDictionary(dns, "DNS 配置必须是对象。");
                remove.Clear();
                foreach (string key in dnsConfig.Keys)
                    if (String.Equals(key, "listen", StringComparison.OrdinalIgnoreCase)) remove.Add(key);
                foreach (string key in remove) dnsConfig.Remove(key);
            }
            RewriteProviderPaths(config, "proxy-providers", "proxy");
            RewriteProviderPaths(config, "rule-providers", "rule");
            object proxies;
            if (config.TryGetValue("proxies", out proxies)) RequireInlineCredentials(proxies, null);
            object rawProviders;
            if (config.TryGetValue("proxy-providers", out rawProviders))
                foreach (object provider in AsDictionary(rawProviders, "provider 配置必须是对象。").Values) RequireInlineCredentials(provider, null);
            object ntp;
            if (config.TryGetValue("ntp", out ntp))
            {
                Dictionary<string, object> ntpConfig = AsDictionary(ntp, "NTP 配置必须是对象。");
                remove.Clear();
                foreach (string key in ntpConfig.Keys) if (String.Equals(key, "write-to-system", StringComparison.OrdinalIgnoreCase)) remove.Add(key);
                foreach (string key in remove) ntpConfig.Remove(key);
                ntpConfig["write-to-system"] = false;
            }
            return config;
        }

        private static void RequireInlineCredentials(object input, string proxyType)
        {
            object[] array = input as object[];
            if (array != null)
            {
                foreach (object item in array) RequireInlineCredentials(item, proxyType);
                return;
            }
            Dictionary<string, object> dictionary = input as Dictionary<string, object>;
            if (dictionary == null) return;
            foreach (KeyValuePair<string, object> pair in dictionary)
                if (String.Equals(pair.Key, "type", StringComparison.OrdinalIgnoreCase) && pair.Value is string) proxyType = ((string)pair.Value).ToLowerInvariant();
            foreach (KeyValuePair<string, object> pair in dictionary)
            {
                string key = pair.Key.ToLowerInvariant();
                if (key == "certificate" || key == "private-key" || key == "client-key")
                {
                    string value = pair.Value as string;
                    if (value == null) throw new HostException("订阅中的证书和私钥必须是 PEM 内联字符串。");
                    if (value.Length == 0) continue;
                    if (key == "private-key" && proxyType == "wireguard")
                    {
                        try { if (Convert.FromBase64String(value).Length == 32) continue; } catch (FormatException) { }
                    }
                    bool inline = key == "certificate" ?
                        value.Contains("-----BEGIN CERTIFICATE-----") && value.Contains("-----END CERTIFICATE-----") :
                        Regex.IsMatch(value, @"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----") &&
                        Regex.IsMatch(value, @"-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----");
                    if (!inline) throw new HostException("此扩展的订阅证书和私钥只支持 PEM 内联内容，不支持本机文件路径。请将证书或私钥内联到 YAML/JSON 配置后重试。");
                }
                else RequireInlineCredentials(pair.Value, proxyType);
            }
        }

        private static void RewriteProviderPaths(Dictionary<string, object> config, string key, string category)
        {
            object rawProviders;
            if (!config.TryGetValue(key, out rawProviders)) return;
            Dictionary<string, object> providers = AsDictionary(rawProviders, "provider 配置必须是对象。");
            foreach (KeyValuePair<string, object> pair in providers)
            {
                Dictionary<string, object> provider = AsDictionary(pair.Value, "provider 条目必须是对象。");
                List<string> remove = new List<string>();
                foreach (string field in provider.Keys) if (String.Equals(field, "path", StringComparison.OrdinalIgnoreCase)) remove.Add(field);
                foreach (string field in remove) provider.Remove(field);
                // Provider caches stay in this package even if a subscription supplies ../ or an absolute path.
                provider["path"] = "providers/" + category + "_" + Hash(pair.Key).Substring(0, 24) + ".yaml";
            }
        }

        private static void PersistRuntimeConfiguration(Dictionary<string, object> patch)
        {
            try
            {
                Dictionary<string, object> config = AsDictionary(Json.DeserializeObject(File.ReadAllText(ConfigurationPath, Encoding.UTF8)), "本机配置无效。");
                foreach (KeyValuePair<string, object> pair in patch) config[pair.Key] = pair.Value;
                AtomicWrite(ConfigurationPath, Json.Serialize(SanitizeConfiguration(config)));
            }
            catch (HostException) { throw; }
            catch { throw new HostException("运行模式已更新，但无法保存到本机配置。请检查 data 目录写入权限。"); }
        }

        private static object RemoveSensitiveValues(object input)
        {
            Dictionary<string, object> dictionary = input as Dictionary<string, object>;
            if (dictionary != null)
            {
                Dictionary<string, object> result = new Dictionary<string, object>();
                foreach (KeyValuePair<string, object> pair in dictionary)
                {
                    string key = pair.Key.ToLowerInvariant();
                    if (key == "secret" || key == "password" || key == "passwd" || key == "uuid" || key == "private-key" || key == "token" || key == "authentication" || key == "authorization" || key == "client-key") continue;
                    result[pair.Key] = RemoveSensitiveValues(pair.Value);
                }
                return result;
            }
            object[] array = input as object[];
            if (array != null)
            {
                object[] result = new object[array.Length];
                for (int index = 0; index < array.Length; index++) result[index] = RemoveSensitiveValues(array[index]);
                return result;
            }
            string value = input as string;
            return value == null ? input : Redact(value);
        }

        private static void AddLog(string line)
        {
            string safe = Redact(line);
            if (safe.Length > 2000) safe = safe.Substring(0, 2000) + "…";
            lock (LogLock)
            {
                Logs.Enqueue(safe);
                LogCharacters += safe.Length;
                // Even six-byte JSON escaping per character fits the response frame.
                while (Logs.Count > 300 || LogCharacters > 100000) LogCharacters -= Logs.Dequeue().Length;
                PersistLog(safe);
            }
        }

        private static void PersistLog(string line)
        {
            try
            {
                string current = CheckedDataPath("host.log");
                string previous = CheckedDataPath("host.previous.log");
                Directory.CreateDirectory(DataDirectory);
                string text = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine;
                int bytes = Encoding.UTF8.GetByteCount(text);
                if (File.Exists(current) && new FileInfo(current).Length + bytes > MaximumLogFileBytes)
                {
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(current, previous);
                }
                File.AppendAllText(current, text, new UTF8Encoding(false));
            }
            catch (Exception exception)
            {
                // File errors must not write plaintext to stdout or break framing.
                Console.Error.WriteLine("EdgeLink log file: " + exception.GetType().Name);
            }
        }

        private static string CheckedDataPath(string fileName)
        {
            string root = Path.GetFullPath(DataDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string path = Path.GetFullPath(Path.Combine(root, fileName));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("Log path outside data directory.");
            return path;
        }

        private static string Redact(string value)
        {
            if (value == null) return null;
            if (!String.IsNullOrEmpty(Secret)) value = value.Replace(Secret, "[已隐藏]");
            value = Regex.Replace(value, @"([a-z][a-z0-9+.-]*://)[^\s/@]+@", "$1[已隐藏]@", RegexOptions.IgnoreCase);
            value = Regex.Replace(value, @"([""']?(?:password|passwd|secret|token|uuid|authorization|private-key)[""']?\s*[:=]\s*)(?:""(?:[^""\\]|\\.)*""|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)", "$1[已隐藏]", RegexOptions.IgnoreCase);
            return value;
        }

        private static void AtomicWrite(string path, string text)
        {
            string temporary = Path.Combine(Path.GetDirectoryName(path), "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllText(temporary, text, new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static string Hash(string value)
        {
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] bytes = algorithm.ComputeHash(Encoding.UTF8.GetBytes(value));
                StringBuilder text = new StringBuilder(bytes.Length * 2);
                foreach (byte item in bytes) text.Append(item.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static string Quote(string path) { return "\"" + path + "\""; }

        private static string GetString(Dictionary<string, object> value, string key, bool required)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || !(raw is string) || (required && String.IsNullOrEmpty((string)raw)))
                throw new HostException("缺少有效的 " + key + " 字段。");
            return (string)raw;
        }

        private static Dictionary<string, object> AsDictionary(object value, string error)
        {
            Dictionary<string, object> dictionary = value as Dictionary<string, object>;
            if (dictionary == null) throw new HostException(error);
            return dictionary;
        }

        private static Dictionary<string, object> Result(object id, bool ok, object data, string error)
        {
            return new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "data", data }, { "error", error } };
        }

        private static void WriteFrame(Stream output, object result)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(result));
            if (bytes.Length > MaximumResponseBytes)
            {
                Dictionary<string, object> previous = result as Dictionary<string, object>;
                object id = previous != null ? previous["id"] : null;
                bytes = Encoding.UTF8.GetBytes(Json.Serialize(Result(id, false, null, "响应超过原生消息的 1 MiB 上限，请减少数据量后重试。")));
            }
            int length = bytes.Length;
            byte[] header = { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
            output.Write(header, 0, header.Length);
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }

        private static bool ReadFully(Stream stream, byte[] buffer, int offset, int count, bool allowEof)
        {
            int total = 0;
            while (total < count)
            {
                int read = stream.Read(buffer, offset + total, count - total);
                if (read == 0)
                {
                    if (total == 0 && allowEof) return false;
                    throw new IOException("Incomplete native frame.");
                }
                total += read;
            }
            return true;
        }

        private sealed class HostException : Exception
        {
            internal HostException(string message) : base(message) { }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobBasicLimitInformation
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobExtendedLimitInformation
        {
            internal JobBasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
