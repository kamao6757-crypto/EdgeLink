using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("EdgeLink Offline Setup")]
[assembly: AssemblyDescription("Offline installer for the EdgeLink extension and independent local Mihomo core")]
[assembly: AssemblyVersion("0.1.3.0")]
[assembly: AssemblyFileVersion("0.1.3.0")]

namespace EdgeLinkSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool commandLine = args.Length > 0;
            try
            {
                PackageInfo package = Installation.ReadPackageInfo();
                if (commandLine)
                {
                    if (args.Length != 2 || (args[0] != "--extract-only" && args[0] != "--install-test"))
                        throw new InstallException("ARGUMENTS_INVALID", "命令格式无效。");
                    bool register = args[0] == "--install-test";
                    string destination = Path.GetFullPath(args[1]);
                    string hostName = register ? Installation.TestHostName(destination) : null;
                    InstallResult result = Installation.ExtractAndVerify(package, destination);
                    if (register) Installation.RegisterHost(result, hostName);
                    Console.WriteLine(Installation.Json.Serialize(new Dictionary<string, object> {
                        { "ok", true }, { "mode", register ? "install-test" : "extract-only" },
                        { "version", result.Version }, { "files", result.FileCount },
                        { "verified", true }, { "hostName", hostName }
                    }));
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new SetupForm(package));
                return 0;
            }
            catch (Exception exception)
            {
                InstallException expected = exception as InstallException;
                string code = expected != null ? expected.Code : "INSTALLATION_FAILED";
                string message = expected != null ? expected.Message : "安装未完成，请检查安装包完整性和目标文件夹写入权限后重试。";
                if (commandLine) Console.WriteLine(Installation.Json.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", code } }));
                else MessageBox.Show(message, "EdgeLink 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }
        }
    }

    internal sealed class PackageInfo
    {
        internal string Prefix;
        internal string Version;
        internal int FileCount;
    }

    internal sealed class InstallResult
    {
        internal string Directory;
        internal string Version;
        internal string ExtensionId;
        internal int FileCount;
        internal string ExtensionDirectory { get { return Path.Combine(Directory, "extension"); } }
    }

    internal sealed class InstallException : Exception
    {
        internal readonly string Code;
        internal InstallException(string code, string message) : base(message) { Code = code; }
    }

    internal static class Installation
    {
        internal const string ProductionHost = "com.edgelink.mihomo";
        private const string RegistryPrefix = "Software\\Microsoft\\Edge\\NativeMessagingHosts\\";
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 50 };
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        private static Stream Payload()
        {
            Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
            if (stream == null) throw new InstallException("PAYLOAD_MISSING", "安装器未包含离线资源，请重新获取完整安装器。");
            return stream;
        }

        internal static PackageInfo ReadPackageInfo()
        {
            using (Stream payload = Payload())
            using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                ZipArchiveEntry manifest = null;
                string manifestName = null;
                long total = 0;
                if (archive.Entries.Count > 10000) throw new InstallException("PAYLOAD_TOO_LARGE", "安装包的文件数量异常。");
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string name = SafeEntryName(entry.FullName);
                    total = checked(total + entry.Length);
                    if (total > 768L * 1024 * 1024) throw new InstallException("PAYLOAD_TOO_LARGE", "安装包的解压大小异常。");
                    if (name.Equals("extension/manifest.json", StringComparison.OrdinalIgnoreCase) || name.EndsWith("/extension/manifest.json", StringComparison.OrdinalIgnoreCase))
                    {
                        if (manifest != null) throw new InstallException("PAYLOAD_LAYOUT_INVALID", "安装包中出现多个扩展清单。");
                        manifest = entry;
                        manifestName = name;
                    }
                }
                if (manifest == null || manifest.Length > 1024 * 1024) throw new InstallException("PAYLOAD_LAYOUT_INVALID", "安装包缺少扩展清单。");
                Dictionary<string, object> definition;
                using (StreamReader reader = new StreamReader(manifest.Open(), Utf8, true)) definition = Dictionary(Json.DeserializeObject(reader.ReadToEnd()));
                string version = Text(definition, "version");
                if (!Regex.IsMatch(version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$")) throw new InstallException("PACKAGE_VERSION_INVALID", "安装包版本信息无效。");
                PackageInfo result = new PackageInfo { Prefix = manifestName.Substring(0, manifestName.Length - "extension/manifest.json".Length), Version = version };
                HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relative = RelativeName(result, entry.FullName);
                    if (relative.Length == 0) continue;
                    if (!names.Add(relative)) throw new InstallException("ZIP_PATH_DUPLICATE", "安装包包含重复文件路径。");
                    if (relative.Equals("native/data", StringComparison.OrdinalIgnoreCase) || relative.StartsWith("native/data/", StringComparison.OrdinalIgnoreCase) ||
                        relative.Equals("native/registration-backup.json", StringComparison.OrdinalIgnoreCase) || relative.Equals("native/com.edgelink.mihomo.json", StringComparison.OrdinalIgnoreCase))
                        throw new InstallException("PRIVATE_DATA_IN_PAYLOAD", "安装包包含不应随安装器分发的本机配置，请重新获取完整安装器。");
                    if (!relative.EndsWith("/", StringComparison.Ordinal)) result.FileCount++;
                }
                return result;
            }
        }

        private static string SafeEntryName(string name)
        {
            name = name.Replace('\\', '/');
            if (name.Length == 0 || name.StartsWith("/", StringComparison.Ordinal) || name.IndexOf(':') >= 0 || name.IndexOf('\0') >= 0)
                throw new InstallException("ZIP_PATH_INVALID", "安装包包含无效路径。");
            string[] parts = name.TrimEnd('/').Split('/');
            foreach (string part in parts)
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal))
                    throw new InstallException("ZIP_PATH_INVALID", "安装包包含无效路径。");
                foreach (char character in part) if (Char.IsControl(character)) throw new InstallException("ZIP_PATH_INVALID", "安装包包含无效路径。");
                string device = part.Split('.')[0];
                if (Regex.IsMatch(device, "^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase))
                    throw new InstallException("ZIP_PATH_INVALID", "安装包包含无效 Windows 文件名。");
            }
            return name;
        }

        private static string RelativeName(PackageInfo package, string original)
        {
            string name = SafeEntryName(original);
            if (package.Prefix.Length > 0 && name.TrimEnd('/').Equals(package.Prefix.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)) return "";
            if (!name.StartsWith(package.Prefix, StringComparison.OrdinalIgnoreCase)) throw new InstallException("ZIP_PREFIX_INVALID", "安装包包含根目录之外的文件。");
            return name.Substring(package.Prefix.Length);
        }

        private static string ChildPath(string root, string relative)
        {
            string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string result = Path.GetFullPath(Path.Combine(normalizedRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!result.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)) throw new InstallException("ZIP_PREFIX_INVALID", "安装包包含目标目录之外的文件。");
            return result;
        }

        internal static string NewVersionDirectory(string selectedRoot, string version)
        {
            string root = Path.GetFullPath(selectedRoot);
            string preferred = Path.Combine(root, "app-" + version);
            string result = preferred;
            int suffix = 2;
            while (System.IO.Directory.Exists(result) || File.Exists(result)) result = preferred + "-" + suffix++;
            return result;
        }

        internal static InstallResult ExtractAndVerify(PackageInfo package, string destination)
        {
            destination = Path.GetFullPath(destination);
            if (destination.TrimEnd('\\', '/').Equals(Path.GetPathRoot(destination).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
                throw new InstallException("TARGET_INVALID", "请选择具体的安装文件夹。");
            if (System.IO.Directory.Exists(destination) && ((File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0 || System.IO.Directory.GetFileSystemEntries(destination).Length != 0))
                throw new InstallException("TARGET_NOT_EMPTY", "目标文件夹已经包含文件，请选择空文件夹。");
            bool createdRoot = !System.IO.Directory.Exists(destination);
            List<string> createdFiles = new List<string>();
            List<string> createdDirectories = new List<string>();
            System.IO.Directory.CreateDirectory(destination);
            try
            {
                using (Stream payload = Payload())
                using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string relative = RelativeName(package, entry.FullName);
                        if (relative.Length == 0) continue;
                        string target = ChildPath(destination, relative);
                        string directory = relative.EndsWith("/", StringComparison.Ordinal) ? target : Path.GetDirectoryName(target);
                        EnsureDirectory(destination, directory, createdDirectories);
                        if (relative.EndsWith("/", StringComparison.Ordinal)) continue;
                        using (Stream source = entry.Open())
                        using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            createdFiles.Add(target);
                            source.CopyTo(output);
                            if (output.Length != entry.Length) throw new InstallException("PAYLOAD_TRUNCATED", "安装包资源不完整，请重新获取完整安装器。");
                        }
                    }
                }
                return VerifyExtracted(package, destination);
            }
            catch
            {
                // Cleanup only files created by this extraction. Existing folders,
                // other installations and running executables are never removed.
                for (int index = createdFiles.Count - 1; index >= 0; index--) try { File.Delete(createdFiles[index]); } catch { }
                for (int index = createdDirectories.Count - 1; index >= 0; index--) try { System.IO.Directory.Delete(createdDirectories[index], false); } catch { }
                if (createdRoot) try { System.IO.Directory.Delete(destination, false); } catch { }
                throw;
            }
        }

        private static void EnsureDirectory(string root, string directory, List<string> created)
        {
            if (System.IO.Directory.Exists(directory)) return;
            string parent = Path.GetDirectoryName(directory);
            if (!String.IsNullOrEmpty(parent) && !parent.Equals(root, StringComparison.OrdinalIgnoreCase)) EnsureDirectory(root, parent, created);
            System.IO.Directory.CreateDirectory(directory);
            created.Add(directory);
        }

        private static InstallResult VerifyExtracted(PackageInfo package, string directory)
        {
            string[] required = { "extension/manifest.json", "extension/background.js", "extension/dashboard.html", "extension/popup.html", "native/EdgeLink.Host.exe", "native/bin/mihomo.exe", "native/extension-id.txt", "native/CORE-SOURCE.json", "native/GEODATA-SOURCE.json", "native/geodata/Country.mmdb", "native/geodata/GeoIP.dat", "native/geodata/GeoSite.dat", "scripts/uninstall.ps1" };
            foreach (string file in required)
                if (!File.Exists(ChildPath(directory, file)) || new FileInfo(ChildPath(directory, file)).Length == 0) throw new InstallException("REQUIRED_FILE_MISSING", "安装包缺少扩展、本机助手或内核资源，请重新获取完整安装器。");
            Dictionary<string, object> manifest = ReadJson(ChildPath(directory, "extension/manifest.json"));
            if (Text(manifest, "version") != package.Version || Convert.ToInt32(manifest["manifest_version"]) != 3) throw new InstallException("EXTENSION_MANIFEST_INVALID", "扩展版本或清单格式无效。");
            string id = File.ReadAllText(ChildPath(directory, "native/extension-id.txt"), Utf8).Trim();
            if (!Regex.IsMatch(id, "^[a-p]{32}$") || id != ExtensionId(Text(manifest, "key"))) throw new InstallException("EXTENSION_ID_INVALID", "扩展身份校验失败，请重新获取完整安装器。");
            foreach (string executable in new string[] { "native/EdgeLink.Host.exe", "native/bin/mihomo.exe" })
                using (FileStream file = File.OpenRead(ChildPath(directory, executable)))
                    if (file.ReadByte() != 'M' || file.ReadByte() != 'Z') throw new InstallException("EXECUTABLE_INVALID", "本机助手或内核文件无效。");
            Dictionary<string, object> core = ReadJson(ChildPath(directory, "native/CORE-SOURCE.json"));
            if (!HashFile(ChildPath(directory, "native/bin/mihomo.exe")).Equals(Text(core, "binarySha256"), StringComparison.OrdinalIgnoreCase)) throw new InstallException("CORE_HASH_MISMATCH", "内置内核完整性校验失败。");
            Dictionary<string, object> geo = ReadJson(ChildPath(directory, "native/GEODATA-SOURCE.json"));
            object[] files = geo["files"] as object[];
            if (files == null) throw new InstallException("GEODATA_METADATA_INVALID", "Geo 资源校验清单无效。");
            HashSet<string> verified = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object raw in files)
            {
                Dictionary<string, object> entry = Dictionary(raw);
                string name = Text(entry, "file");
                if (name != "Country.mmdb" && name != "GeoIP.dat" && name != "GeoSite.dat") continue;
                string file = ChildPath(directory, "native/geodata/" + name);
                if (new FileInfo(file).Length != Convert.ToInt64(entry["size"]) || !HashFile(file).Equals(Text(entry, "sha256"), StringComparison.OrdinalIgnoreCase))
                    throw new InstallException("GEODATA_HASH_MISMATCH", "内置 Geo 数据完整性校验失败。");
                verified.Add(name);
            }
            if (verified.Count != 3) throw new InstallException("GEODATA_METADATA_INVALID", "Geo 资源校验清单不完整。");
            return new InstallResult { Directory = directory, Version = package.Version, ExtensionId = id, FileCount = package.FileCount };
        }

        internal static string TestHostName(string directory)
        {
            using (SHA256 algorithm = SHA256.Create()) return "com.edgelink.installtest." + Hex(algorithm.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToLowerInvariant()))).Substring(0, 16);
        }

        internal static void RegisterHost(InstallResult result, string hostName)
        {
            if (hostName != ProductionHost && !Regex.IsMatch(hostName, "^com\\.edgelink\\.installtest\\.[a-f0-9]{16}$")) throw new InstallException("HOST_NAME_INVALID", "本机助手注册名称无效。");
            string manifest = ChildPath(result.Directory, "native/" + hostName + ".json");
            string keyPath = RegistryPrefix + hostName;
            object previous = null;
            bool hadKey;
            using (RegistryKey existing = Registry.CurrentUser.OpenSubKey(keyPath))
            {
                hadKey = existing != null;
                if (existing != null) previous = existing.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            }
            File.WriteAllText(manifest, Json.Serialize(new Dictionary<string, object> {
                { "name", hostName }, { "description", "EdgeLink independent Mihomo core host" },
                { "path", ChildPath(result.Directory, "native/EdgeLink.Host.exe") }, { "type", "stdio" },
                { "allowed_origins", new string[] { "chrome-extension://" + result.ExtensionId + "/" } }
            }), Utf8);
            File.WriteAllText(ChildPath(result.Directory, "native/registration-backup.json"), Json.Serialize(new Dictionary<string, object> { { "previous", previous }, { "installed", manifest } }), Utf8);
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath))
                {
                    if (key == null) throw new InstallException("REGISTRATION_FAILED", "无法注册当前用户的本机助手。");
                    key.SetValue("", manifest, RegistryValueKind.String);
                }
            }
            catch
            {
                try
                {
                    if (!hadKey) Registry.CurrentUser.DeleteSubKey(keyPath, false);
                    else using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath, true))
                    {
                        if (key != null) { if (previous != null) key.SetValue("", previous, RegistryValueKind.String); else key.DeleteValue("", false); }
                    }
                }
                catch { }
                throw new InstallException("REGISTRATION_FAILED", "无法注册当前用户的本机助手，请检查当前用户的注册表写入权限。已解压的安装文件会保留。");
            }
        }

        private static Dictionary<string, object> ReadJson(string file) { return Dictionary(Json.DeserializeObject(File.ReadAllText(file, Utf8))); }
        private static Dictionary<string, object> Dictionary(object value)
        {
            Dictionary<string, object> result = value as Dictionary<string, object>;
            if (result == null) throw new InstallException("PACKAGE_METADATA_INVALID", "安装包校验清单无效。");
            return result;
        }
        private static string Text(Dictionary<string, object> value, string key)
        {
            object result;
            if (!value.TryGetValue(key, out result) || !(result is string)) throw new InstallException("PACKAGE_METADATA_INVALID", "安装包校验清单无效。");
            return (string)result;
        }
        private static string ExtensionId(string publicKey)
        {
            byte[] key;
            try { key = Convert.FromBase64String(publicKey); } catch { throw new InstallException("EXTENSION_ID_INVALID", "扩展公钥无效。"); }
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(key);
                StringBuilder id = new StringBuilder(32);
                for (int index = 0; index < 16; index++) { id.Append((char)('a' + (digest[index] >> 4))); id.Append((char)('a' + (digest[index] & 15))); }
                return id.ToString();
            }
        }
        private static string HashFile(string file) { using (SHA256 algorithm = SHA256.Create()) using (FileStream input = File.OpenRead(file)) return Hex(algorithm.ComputeHash(input)); }
        private static string Hex(byte[] bytes) { StringBuilder value = new StringBuilder(bytes.Length * 2); foreach (byte item in bytes) value.Append(item.ToString("x2")); return value.ToString(); }
    }

    internal sealed class SetupForm : Form
    {
        private readonly PackageInfo Package;
        private readonly TextBox RootBox;
        private readonly TextBox ExtensionBox;
        private readonly Button InstallButton;
        private readonly Button BrowseButton;
        private readonly Button EdgeButton;
        private readonly Button FolderButton;
        private readonly Label StateLabel;
        private InstallResult Installed;
        private readonly Color Muted = Color.FromArgb(162, 173, 198);
        private readonly Color Accent = Color.FromArgb(59, 116, 222);

        internal SetupForm(PackageInfo package)
        {
            Package = package;
            Text = "EdgeLink 离线安装";
            ClientSize = new Size(720, 570);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(23, 29, 44);
            ForeColor = Color.FromArgb(239, 244, 255);
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Font;
            Controls.Add(LabelAt("EdgeLink", 32, 24, 420, 48, 28F, FontStyle.Bold));
            Label subtitle = LabelAt("独立本机内核 · 离线安装 · v" + package.Version, 35, 76, 620, 28, 10F, FontStyle.Regular);
            subtitle.ForeColor = Muted;
            Controls.Add(subtitle);
            Controls.Add(LabelAt("1   安装本机助手与独立内核", 34, 129, 640, 34, 15F, FontStyle.Bold));
            Label firstDescription = LabelAt("已内置 Mihomo 与 Geo 数据，无需额外下载或管理员权限。", 35, 171, 650, 24, 9F, FontStyle.Regular);
            firstDescription.ForeColor = Muted;
            Controls.Add(firstDescription);
            Controls.Add(LabelAt("安装根目录", 35, 205, 100, 24, 9F, FontStyle.Regular));
            RootBox = TextBoxAt(35, 233, 544, 28);
            RootBox.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EdgeLink");
            BrowseButton = ButtonAt("选择…", 589, 231, 95, 34, false);
            BrowseButton.Click += delegate { using (FolderBrowserDialog dialog = new FolderBrowserDialog()) { dialog.Description = "选择 EdgeLink 安装根目录"; dialog.SelectedPath = RootBox.Text; if (dialog.ShowDialog(this) == DialogResult.OK) RootBox.Text = dialog.SelectedPath; } };
            InstallButton = ButtonAt("安装到本机", 35, 279, 154, 40, true);
            StateLabel = LabelAt("会创建独立版本文件夹，并保留已有安装。", 205, 284, 475, 56, 9F, FontStyle.Regular);
            StateLabel.ForeColor = Muted;
            Controls.Add(StateLabel);
            Controls.Add(LabelAt("2   在 Edge 中加载扩展", 34, 352, 640, 34, 15F, FontStyle.Bold));
            Label secondDescription = LabelAt("打开 edge://extensions，开启「开发人员模式」，点击「加载解压缩的扩展」，\n选择下方 extension 文件夹。Edge 需要你手动完成这一步。", 35, 392, 649, 48, 9F, FontStyle.Regular);
            secondDescription.ForeColor = Muted;
            Controls.Add(secondDescription);
            ExtensionBox = TextBoxAt(35, 449, 649, 28);
            ExtensionBox.ReadOnly = true;
            ExtensionBox.Text = "安装完成后显示 extension 文件夹位置";
            EdgeButton = ButtonAt("打开 Edge 扩展页", 35, 493, 181, 38, true);
            FolderButton = ButtonAt("打开 extension 文件夹", 229, 493, 203, 38, false);
            EdgeButton.Enabled = FolderButton.Enabled = false;
            EdgeButton.Click += delegate { TryOpen("msedge.exe", "edge://extensions", "请在 Edge 地址栏输入 edge://extensions。"); };
            FolderButton.Click += delegate { if (Installed != null) TryOpen("explorer.exe", "\"" + Installed.ExtensionDirectory + "\"", "请手动打开上方 extension 文件夹。"); };
            InstallButton.Click += BeginInstallation;
        }

        private Label LabelAt(string text, int x, int y, int width, int height, float size, FontStyle style)
        {
            return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), Font = new Font("Microsoft YaHei UI", size, style), BackColor = Color.Transparent };
        }
        private TextBox TextBoxAt(int x, int y, int width, int height)
        {
            TextBox box = new TextBox { Location = new Point(x, y), Size = new Size(width, height), BackColor = Color.FromArgb(35, 43, 62), ForeColor = ForeColor, BorderStyle = BorderStyle.FixedSingle };
            Controls.Add(box);
            return box;
        }
        private Button ButtonAt(string text, int x, int y, int width, int height, bool primary)
        {
            Button button = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, height), FlatStyle = FlatStyle.Flat, BackColor = primary ? Accent : Color.FromArgb(35, 43, 62), ForeColor = Color.White };
            button.FlatAppearance.BorderSize = 0;
            Controls.Add(button);
            return button;
        }
        private void BeginInstallation(object sender, EventArgs args)
        {
            string root = RootBox.Text;
            if (String.IsNullOrWhiteSpace(root)) { MessageBox.Show("请选择安装根目录。", Text); return; }
            InstallButton.Enabled = BrowseButton.Enabled = RootBox.Enabled = false;
            StateLabel.Text = "正在解压、校验并注册本机助手…";
            BackgroundWorker worker = new BackgroundWorker();
            worker.DoWork += delegate(object unused, DoWorkEventArgs work) {
                string directory = Installation.NewVersionDirectory(root, Package.Version);
                InstallResult result = Installation.ExtractAndVerify(Package, directory);
                Installation.RegisterHost(result, Installation.ProductionHost);
                work.Result = result;
            };
            worker.RunWorkerCompleted += delegate(object unused, RunWorkerCompletedEventArgs complete) {
                BrowseButton.Enabled = RootBox.Enabled = true;
                if (complete.Error != null) {
                    InstallButton.Enabled = true;
                    StateLabel.Text = "安装未完成，可检查目标文件夹后重试。";
                    InstallException expected = complete.Error as InstallException;
                    MessageBox.Show(expected != null ? expected.Message : "安装未完成，请检查安装包完整性和目标文件夹写入权限后重试。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                } else {
                    Installed = (InstallResult)complete.Result;
                    StateLabel.Text = "本机助手已安装，请继续完成第 2 步。";
                    StateLabel.ForeColor = Color.FromArgb(113, 210, 169);
                    InstallButton.Text = "已安装";
                    ExtensionBox.Text = Installed.ExtensionDirectory;
                    EdgeButton.Enabled = FolderButton.Enabled = true;
                }
                worker.Dispose();
            };
            worker.RunWorkerAsync();
        }
        private void TryOpen(string executable, string arguments, string fallback)
        {
            try { Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = true }); }
            catch { MessageBox.Show(fallback, Text, MessageBoxButtons.OK, MessageBoxIcon.Information); }
        }
    }
}
