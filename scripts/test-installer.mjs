import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
let testRegistration = false;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--test-registration') testRegistration = true;
  else {
    const name = process.argv[index];
    const value = process.argv[++index];
    if (!value || !['--installer', '--package', '--report'].includes(name)) throw new Error('INVALID_TEST_ARGUMENTS');
    options.set(name, path.resolve(projectRoot, value));
  }
}
const installerPath = options.get('--installer') || path.join(projectRoot, 'dist', 'EdgeLink-Setup-v0.1.3-win-x64.exe');
const packagePath = options.get('--package') || path.join(projectRoot, 'dist', 'EdgeLink-v0.1.3-win-x64.zip');
const reportPath = options.get('--report') || path.join(projectRoot, 'output', 'diagnostics', 'installer-report.json');
const tempPrefix = 'edgelink-installer-test-';
const startedAt = Date.now();
const report = { schemaVersion: 1, startedAt: new Date(startedAt).toISOString(), checks: [], registrationTestRequested: testRegistration, cleanup: { testRegistrationRemoved: true, validatedTemporaryTarget: false, temporaryDirectoryRemoved: false }, status: 'running' };
let temporaryRoot;
let testHostName;
let registryHelper;

function assert(value, code) { if (!value) throw new Error(code); }
function inside(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function validateTemp() { assert(temporaryRoot && inside(os.tmpdir(), temporaryRoot) && path.basename(temporaryRoot).startsWith(tempPrefix), 'UNSAFE_TEMPORARY_DIRECTORY'); report.cleanup.validatedTemporaryTarget = true; }
function tempPath(...parts) { validateTemp(); const target = path.resolve(temporaryRoot, ...parts); assert(inside(temporaryRoot, target), 'UNSAFE_TEST_TARGET'); return target; }
function check(name, details = {}) { report.checks.push({ name, passed: true, ...details }); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function sha256(file) { const digest = crypto.createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
async function writePowerShell(file, text) { await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])); }
function powershell() { return path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }

async function run(executable, args, allowFailure = false) {
  const child = spawn(executable, args, { cwd: temporaryRoot, windowsHide: true, env: { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderrBytes = 0;
  child.stdout.on('data', data => { if (stdout.length < 65536) stdout += data.toString('utf8'); });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('INSTALLER_TEST_PROCESS_TIMEOUT')); }, 60000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('INSTALLER_TEST_PROCESS_SPAWN_FAILED')); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderrBytes }); });
  });
  if (!allowFailure) assert(result.code === 0, 'INSTALLER_TEST_PROCESS_FAILED');
  return result;
}

async function prepareHelpers() {
  const helper = tempPath('inspect-package.ps1');
  await writePowerShell(helper, String.raw`
param([string]$InstallerPath, [string]$PackagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-ZipJson($Archive, [string]$Relative) {
    $entry = $Archive.Entries | Where-Object { $_.FullName.Replace('\','/').EndsWith('/' + $Relative, [StringComparison]::OrdinalIgnoreCase) -or $_.FullName.Replace('\','/') -eq $Relative } | Select-Object -First 1
    if (-not $entry) { throw 'PACKAGE_METADATA_MISSING' }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
    $extension = Read-ZipJson $archive 'extension/manifest.json'
    $core = Read-ZipJson $archive 'native/CORE-SOURCE.json'
    $geo = Read-ZipJson $archive 'native/GEODATA-SOURCE.json'
    $assembly = [Reflection.Assembly]::LoadFile($InstallerPath)
    $stream = $assembly.GetManifestResourceStream('payload.zip')
    if (-not $stream) { throw 'EMBEDDED_PAYLOAD_MISSING' }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $payloadHash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose(); $stream.Dispose() }
    $files = @($geo.files | ForEach-Object { [ordered]@{ file = $_.file; bytes = $_.size; sha256 = $_.sha256 } })
    [ordered]@{ version = $extension.version; coreVersion = $core.version; coreSha256 = $core.binarySha256; embeddedPayloadSha256 = $payloadHash; geodata = $files } | ConvertTo-Json -Depth 5 -Compress
} finally { $archive.Dispose() }
`);
  registryHelper = tempPath('test-registration.ps1');
  await writePowerShell(registryHelper, String.raw`
param([string]$Action, [string]$HostName, [string]$Value = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($HostName -notmatch '^com\.edgelink\.installtest\.[a-f0-9]{16}$') { throw 'UNSAFE_REGISTRY_TEST_NAMESPACE' }
$keyPath = 'Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName
if ($Action -eq 'set') {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
    try { $key.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
} elseif ($Action -eq 'get') {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
    if ($null -eq $key) { [ordered]@{ exists = $false; value = $null } | ConvertTo-Json -Compress }
    else { try { [ordered]@{ exists = $true; value = $key.GetValue('') } | ConvertTo-Json -Compress } finally { $key.Dispose() } }
} elseif ($Action -eq 'delete') {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyPath, $false)
} else { throw 'UNKNOWN_REGISTRY_TEST_ACTION' }
`);
  return helper;
}

async function registryAction(action, value = '') {
  assert(/^com\.edgelink\.installtest\.[a-f0-9]{16}$/.test(testHostName), 'UNSAFE_REGISTRY_TEST_NAMESPACE');
  return run(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', registryHelper, '-Action', action, '-HostName', testHostName, '-Value', value]);
}

async function testIsolatedRegistration(executable, metadata) {
  const target = tempPath('registered-fixture');
  testHostName = `com.edgelink.installtest.${crypto.createHash('sha256').update(target.toLowerCase(), 'utf8').digest('hex').slice(0, 16)}`;
  const before = JSON.parse((await registryAction('get')).stdout.trim());
  assert(!before.exists, 'TEST_REGISTRY_NAMESPACE_ALREADY_EXISTS');
  report.cleanup.testRegistrationRemoved = false;
  const previous = 'isolated-registration-fixture';
  await registryAction('set', previous);
  const result = await run(executable, ['--install-test', target]);
  assert(result.code === 0, 'ISOLATED_REGISTRATION_INSTALL_FAILED');
  const mapping = JSON.parse((await registryAction('get')).stdout.trim());
  const manifestPath = path.join(target, 'native', `${testHostName}.json`);
  assert(mapping.exists && mapping.value.toLowerCase() === manifestPath.toLowerCase(), 'ISOLATED_REGISTRY_MAPPING_INVALID');
  const backup = JSON.parse(await fs.readFile(path.join(target, 'native', 'registration-backup.json'), 'utf8'));
  assert(backup.previous === previous && backup.installed.toLowerCase() === manifestPath.toLowerCase(), 'REGISTRATION_BACKUP_SCHEMA_INVALID');
  const host = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert(host.name === testHostName && host.path.toLowerCase() === path.join(target, 'native', 'EdgeLink.Host.exe').toLowerCase() && host.type === 'stdio', 'ISOLATED_NATIVE_MANIFEST_INVALID');
  const extension = JSON.parse(await fs.readFile(path.join(target, 'extension', 'manifest.json'), 'utf8'));
  assert(extension.version === metadata.version && Array.isArray(host.allowed_origins) && host.allowed_origins.length === 1, 'ISOLATED_NATIVE_ORIGIN_INVALID');
  assert(!await exists(path.join(target, 'native', 'data')), 'INSTALLATION_STARTED_CORE_OR_CREATED_RUNTIME_DATA');
  await registryAction('set', backup.previous);
  assert(JSON.parse((await registryAction('get')).stdout.trim()).value === previous, 'TEST_REGISTRATION_RESTORE_FAILED');
  await registryAction('delete');
  report.cleanup.testRegistrationRemoved = !JSON.parse((await registryAction('get')).stdout.trim()).exists;
  assert(report.cleanup.testRegistrationRemoved, 'TEST_REGISTRATION_CLEANUP_FAILED');
  check('independent_test_registration_and_legacy_backup_schema', { productionHostUntouched: true, previousMappingRestorable: true });
}

async function testZipTraversal() {
  const zipPath = tempPath('path-traversal-fixture.zip');
  const helperPath = tempPath('make-traversal-fixture.ps1');
  await writePowerShell(helperPath, String.raw`
param([string]$ZipPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    $entry = $archive.CreateEntry('BadPayload/../zip-escape-marker.txt')
    $writer = New-Object IO.StreamWriter($entry.Open())
    try { $writer.Write('isolated-path-fixture') } finally { $writer.Dispose() }
    $entry = $archive.CreateEntry('BadPayload/extension/manifest.json')
    $writer = New-Object IO.StreamWriter($entry.Open())
    try { $writer.Write('{"manifest_version":3,"version":"0.1.3","key":"AA=="}') } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
`);
  await run(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-ZipPath', zipPath]);
  const windows = process.env.WINDIR || 'C:\\Windows';
  let framework;
  for (const architecture of ['Framework64', 'Framework']) {
    const candidate = path.join(windows, 'Microsoft.NET', architecture, 'v4.0.30319');
    if (await exists(path.join(candidate, 'csc.exe'))) { framework = candidate; break; }
  }
  assert(framework, 'FRAMEWORK_COMPILER_MISSING');
  const source = tempPath('Installer.fixture.cs');
  await fs.copyFile(path.join(projectRoot, 'native', 'Installer.cs'), source);
  const fixtureExe = tempPath('TraversalSetup.exe');
  const references = ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${path.join(framework, name)}`);
  await run(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/langversion:5', `/out:${fixtureExe}`, `/resource:${zipPath},payload.zip`, ...references, source]);
  const result = await run(fixtureExe, ['--extract-only', tempPath('traversal-target')], true);
  assert(result.code !== 0 && !await exists(tempPath('zip-escape-marker.txt')), 'ZIP_PATH_TRAVERSAL_NOT_REJECTED');
  if (result.stdout.trim()) assert(JSON.parse(result.stdout.trim()).error === 'ZIP_PATH_INVALID', 'ZIP_PATH_FAILURE_CODE_INVALID');
  check('zip_path_traversal_rejected_before_extraction');
}

try {
  assert(process.platform === 'win32', 'WINDOWS_ONLY_TEST');
  assert(await exists(installerPath) && await exists(packagePath), 'INSTALLER_OR_PACKAGE_MISSING');
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  validateTemp();
  const copiedInstaller = tempPath('EdgeLink-Setup.exe');
  await fs.copyFile(installerPath, copiedInstaller);
  const helper = await prepareHelpers();
  const metadataResult = await run(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-InstallerPath', copiedInstaller, '-PackagePath', packagePath]);
  const metadata = JSON.parse(metadataResult.stdout.trim());
  report.packageVersion = metadata.version;
  report.coreVersion = metadata.coreVersion;
  report.installerSha256 = await sha256(installerPath);
  report.packageSha256 = await sha256(packagePath);
  assert(metadata.embeddedPayloadSha256 === report.packageSha256, 'EMBEDDED_PAYLOAD_HASH_MISMATCH');
  check('embedded_zip_matches_complete_package', { sha256: report.packageSha256 });
  const image = await fs.readFile(copiedInstaller);
  assert(image.includes(Buffer.from('level="asInvoker"', 'utf8')), 'AS_INVOKER_MANIFEST_MISSING');
  check('installer_has_as_invoker_manifest');
  const target = tempPath('extracted');
  const result = await run(copiedInstaller, ['--extract-only', target]);
  if (result.stdout.trim()) assert(JSON.parse(result.stdout.trim()).ok === true, 'EXTRACT_ONLY_RESULT_INVALID');
  const extension = JSON.parse(await fs.readFile(path.join(target, 'extension', 'manifest.json'), 'utf8'));
  assert(extension.version === metadata.version && extension.manifest_version === 3, 'EXTRACTED_EXTENSION_VERSION_MISMATCH');
  const actualCoreHash = await sha256(path.join(target, 'native', 'bin', 'mihomo.exe'));
  assert(actualCoreHash === metadata.coreSha256, 'EXTRACTED_CORE_HASH_MISMATCH');
  report.coreSha256 = actualCoreHash;
  report.geodata = {};
  for (const item of metadata.geodata) {
    const file = path.join(target, 'native', 'geodata', item.file);
    const stat = await fs.stat(file);
    const hash = await sha256(file);
    assert(stat.size === item.bytes && hash === item.sha256, 'EXTRACTED_GEODATA_HASH_MISMATCH');
    report.geodata[item.file] = { bytes: stat.size, sha256: hash };
  }
  assert(Object.keys(report.geodata).length === 3, 'GEODATA_FILE_COUNT_INVALID');
  assert(await exists(path.join(target, 'native', 'EdgeLink.Host.exe')), 'EXTRACTED_NATIVE_HELPER_MISSING');
  assert(!await exists(path.join(target, 'native', 'data')) && !await exists(path.join(target, 'native', 'registration-backup.json')) && !await exists(path.join(target, 'native', 'com.edgelink.mihomo.json')), 'EXTRACT_ONLY_CREATED_RUNTIME_OR_REGISTRATION_DATA');
  check('extract_only_verifies_extension_helper_core_and_geodata', { extensionVersion: extension.version, coreHashMatches: true, geodataFiles: 3, registrationPerformed: false, coreStarted: false });
  const repeated = await run(copiedInstaller, ['--extract-only', target], true);
  assert(repeated.code !== 0 && await sha256(path.join(target, 'native', 'bin', 'mihomo.exe')) === actualCoreHash, 'EXISTING_INSTALLATION_OVERWRITTEN');
  check('nonempty_destination_preserved');
  if (testRegistration) await testIsolatedRegistration(copiedInstaller, metadata);
  await testZipTraversal();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failureCode = /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'INSTALLER_TEST_IO_FAILURE';
  process.exitCode = 1;
} finally {
  if (testHostName && registryHelper && !report.cleanup.testRegistrationRemoved) {
    try { await registryAction('delete'); report.cleanup.testRegistrationRemoved = !JSON.parse((await registryAction('get')).stdout.trim()).exists; } catch { report.cleanup.testRegistrationRemoved = false; }
  }
  if (temporaryRoot) {
    validateTemp();
    try { await fs.rm(temporaryRoot, { recursive: true, force: true }); report.cleanup.temporaryDirectoryRemoved = !await exists(temporaryRoot); } catch { report.cleanup.temporaryDirectoryRemoved = false; }
  }
  if (report.status === 'passed' && (!report.cleanup.testRegistrationRemoved || !report.cleanup.temporaryDirectoryRemoved)) { report.status = 'failed'; report.failureCode = 'INSTALLER_TEST_CLEANUP_INCOMPLETE'; process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  assert(inside(path.join(projectRoot, 'output', 'diagnostics'), reportPath), 'REPORT_PATH_OUTSIDE_DIAGNOSTICS');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`INSTALLER_TEST_${report.status.toUpperCase()}`);
  if (report.failureCode) console.log(report.failureCode);
}
