import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs only isolated test hosts. It never opens the production data directory,
// changes registration, or connects to the production proxy/controller ports.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceRoot = path.join(projectRoot, 'native', 'geodata');
const reportPath = path.join(projectRoot, 'output', 'diagnostics', 'native-geodata-report.json');
const temporaryPrefix = 'edgelink-native-geo-';
const proxyPort = 37890;
const controllerPort = 37990;
const resourceNames = ['Country.mmdb', 'GeoIP.dat', 'GeoSite.dat'];
const metadataMarker = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com', 'ascii')]);
const startedAt = Date.now();
const hosts = new Set();
let temporaryRoot;

const report = {
  schemaVersion: 1,
  startedAt: new Date(startedAt).toISOString(),
  ports: { proxy: proxyPort, controller: controllerPort },
  isolation: { productionDataAccessed: false, registryChanged: false, productionPortsUsed: false },
  resources: {},
  checks: [],
  cleanup: { validatedTemporaryTarget: false, allHostsExited: false, testPortsClosed: false, temporaryDirectoryRemoved: false },
  status: 'running',
};

function requireCondition(value, code) {
  if (!value) throw new Error(code);
}

function recordCheck(name, details = {}) {
  report.checks.push({ name, passed: true, ...details });
}

function isContained(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateTemporaryRoot() {
  requireCondition(temporaryRoot && isContained(os.tmpdir(), temporaryRoot), 'UNSAFE_TEMPORARY_DIRECTORY');
  requireCondition(path.basename(path.resolve(temporaryRoot)).startsWith(temporaryPrefix), 'UNSAFE_TEMPORARY_PREFIX');
  report.cleanup.validatedTemporaryTarget = true;
}

function fixturePath(...segments) {
  validateTemporaryRoot();
  const result = path.resolve(temporaryRoot, ...segments);
  requireCondition(isContained(temporaryRoot, result), 'FIXTURE_PATH_OUTSIDE_TEMPORARY_DIRECTORY');
  return result;
}

async function hashFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function hasMetadataTail(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < metadataMarker.length) return false;
    const length = Math.min(size, 128 * 1024);
    const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(tail, 0, length, size - length);
    return bytesRead === length && tail.lastIndexOf(metadataMarker) >= 0;
  } finally {
    await handle.close();
  }
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readResources() {
  const provenance = JSON.parse(await fs.readFile(path.join(projectRoot, 'native', 'GEODATA-SOURCE.json'), 'utf8'));
  for (const name of resourceNames) {
    const source = path.join(resourceRoot, name);
    requireCondition(await fileExists(source), 'BUNDLED_RESOURCES_NOT_READY');
    const stat = await fs.stat(source);
    const expected = provenance.files.find(record => record.file === name);
    requireCondition(expected && expected.releaseDigestVerified && stat.size === expected.size, 'BUNDLED_RESOURCE_SIZE_MISMATCH');
    const information = { bytes: stat.size, sha256: await hashFile(source) };
    requireCondition(information.sha256 === expected.sha256, 'BUNDLED_RESOURCE_DIGEST_MISMATCH');
    if (name === 'Country.mmdb') {
      information.metadataTailPresent = await hasMetadataTail(source);
      requireCondition(information.metadataTailPresent, 'BUNDLED_MMDB_METADATA_MISSING');
    }
    report.resources[name] = information;
  }
  recordCheck('bundled_resources_present_with_expected_sizes');
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let complete = false;
    function finish(open) {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve(open);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function requireTestPortsFree() {
  requireCondition(!await portOpen(proxyPort) && !await portOpen(controllerPort), 'TEST_PORTS_ALREADY_IN_USE');
}

async function waitForPortsClosed() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await portOpen(proxyPort) && !await portOpen(controllerPort)) return true;
    await delay(100);
  }
  return false;
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('ISOLATED_PROCESS_EXIT_TIMEOUT'));
    }, milliseconds);
    function onExit() { clearTimeout(timer); resolve(); }
    child.once('exit', onExit);
  });
}

async function runCompiler(executable, args, failureCode) {
  const child = spawn(executable, args, { cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Compiler text is intentionally excluded from both stdout and the report.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  try {
    await waitForExit(child, 30000);
  } catch {
    child.kill();
    throw new Error(failureCode);
  }
  requireCondition(!spawnFailed && child.exitCode === 0, failureCode);
}

async function prepareRealHost() {
  const nativeRoot = fixturePath('real', 'native');
  await fs.mkdir(path.join(nativeRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(nativeRoot, 'geodata'), { recursive: true });
  const original = await fs.readFile(path.join(projectRoot, 'native', 'Host.cs'), 'utf8');
  requireCondition((original.match(/private const int ProxyPort = \d+;/g) || []).length === 1, 'PROXY_PORT_SOURCE_CONTRACT_CHANGED');
  requireCondition((original.match(/private const int ControllerPort = \d+;/g) || []).length === 1, 'CONTROLLER_PORT_SOURCE_CONTRACT_CHANGED');
  const isolated = original.replace(/private const int ProxyPort = \d+;/, `private const int ProxyPort = ${proxyPort};`)
    .replace(/private const int ControllerPort = \d+;/, `private const int ControllerPort = ${controllerPort};`);
  const sourcePath = path.join(nativeRoot, 'Host.cs');
  const hostPath = path.join(nativeRoot, 'EdgeLink.Host.exe');
  await fs.writeFile(sourcePath, isolated, 'utf8');
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await runCompiler(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', 'build-native.ps1'), '-OutputPath', hostPath, '-SourcePath', sourcePath], 'ISOLATED_HOST_COMPILE_FAILED');
  await fs.copyFile(path.join(projectRoot, 'native', 'bin', 'mihomo.exe'), path.join(nativeRoot, 'bin', 'mihomo.exe'));
  for (const name of resourceNames) await fs.copyFile(path.join(resourceRoot, name), path.join(nativeRoot, 'geodata', name));
  recordCheck('isolated_host_compiled_with_windows_powershell_51', { proxyPort, controllerPort });
  return { nativeRoot, hostPath, dataRoot: path.join(nativeRoot, 'data') };
}

class NativePeer {
  constructor(hostPath) {
    requireCondition(isContained(temporaryRoot, hostPath), 'HOST_PATH_OUTSIDE_TEMPORARY_DIRECTORY');
    this.child = spawn(hostPath, [], { cwd: path.dirname(hostPath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 0;
    this.protocolError = false;
    hosts.add(this);
    this.child.stdout.on('data', data => this.receive(data));
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => {});
    this.child.once('error', () => this.rejectPending('ISOLATED_HOST_SPAWN_FAILED'));
    this.child.once('exit', () => this.rejectPending('ISOLATED_HOST_EXITED'));
  }

  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE();
        requireCondition(length > 0 && length < 1024 * 1024, 'NATIVE_RESPONSE_SIZE_INVALID');
        if (this.buffer.length < length + 4) return;
        const response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(length + 4);
        const waiter = this.pending.get(response.id);
        if (waiter) { this.pending.delete(response.id); waiter.resolve(response); }
      }
    } catch {
      this.protocolError = true;
      this.rejectPending('NATIVE_PROTOCOL_INVALID');
    }
  }

  rejectPending(code) {
    for (const waiter of this.pending.values()) waiter.reject(new Error(code));
    this.pending.clear();
  }

  request(command, payload = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('NATIVE_REQUEST_TIMEOUT')); }, 45000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      const body = Buffer.from(JSON.stringify({ id, command, payload }), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      this.child.stdin.write(Buffer.concat([header, body]));
    });
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    try {
      await waitForExit(this.child, 5000);
    } catch {
      // This is the exact child started from the validated temporary executable.
      this.child.kill();
      await waitForExit(this.child, 5000);
    }
    hosts.delete(this);
    return !this.protocolError && this.child.exitCode === 0;
  }
}

function geoConfiguration() {
  return {
    mode: 'rule', 'log-level': 'info', 'geodata-mode': false,
    proxies: [],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['DIRECT'] }],
    rules: ['GEOIP,CN,DIRECT', 'MATCH,DIRECT'],
  };
}

async function requireWorkingCore(peer, code) {
  const status = await peer.request('status');
  const version = await peer.request('request', { method: 'GET', path: '/version' });
  requireCondition(status.ok && status.data.running && version.ok && typeof version.data.version === 'string', code);
  return version.data.version;
}

async function testRealCore(fixture) {
  let peer = new NativePeer(fixture.hostPath);
  let response = await peer.request('start');
  requireCondition(response.ok && response.data.running, 'MISSING_RESOURCE_START_FAILED');
  report.coreVersion = response.data.version;
  for (const name of resourceNames) {
    const target = path.join(fixture.dataRoot, name);
    requireCondition(await fileExists(target) && await hashFile(target) === report.resources[name].sha256, 'MISSING_RESOURCE_COPY_MISMATCH');
  }
  recordCheck('missing_geodata_resources_copied_from_bundle', { fileCount: resourceNames.length });
  requireCondition(await peer.close() && await waitForPortsClosed(), 'FIRST_EOF_CORE_CLEANUP_FAILED');

  await fs.unlink(path.join(fixture.dataRoot, 'Country.mmdb'));
  const databasePath = path.join(fixture.dataRoot, 'geoip.metadb');
  const damagedCacheBytes = 830464;
  await fs.writeFile(databasePath, Buffer.alloc(damagedCacheBytes));
  const configPath = path.join(fixture.dataRoot, 'config.json');
  await fs.writeFile(configPath, '{invalid-isolated-json', 'utf8');
  peer = new NativePeer(fixture.hostPath);
  response = await peer.request('applyConfig', { config: geoConfiguration() });
  requireCondition(response.ok && response.data.applied, 'COLD_APPLY_WITH_DAMAGED_OLD_JSON_FAILED');
  await requireWorkingCore(peer, 'COLD_APPLY_CORE_NOT_WORKING');
  requireCondition(await hasMetadataTail(databasePath) && await hashFile(databasePath) === report.resources['Country.mmdb'].sha256, 'DAMAGED_MMDB_NOT_REPAIRED');
  const repairedBytes = (await fs.stat(databasePath)).size;
  requireCondition(repairedBytes === report.resources['Country.mmdb'].bytes, 'REPAIRED_MMDB_SIZE_MISMATCH');
  recordCheck('damaged_mmdb_and_old_json_cold_apply_recovered', { damagedCacheBytes, repairedBytes, geoRuleValidated: true });
  requireCondition(await peer.close() && await waitForPortsClosed(), 'SECOND_EOF_CORE_CLEANUP_FAILED');

  // The MaxMind map decoder accepts a trailing zero byte. Mihomo validation
  // below proves this fixture still works, while its differing hash detects an
  // accidental overwrite with the bundled database.
  await fs.appendFile(databasePath, Buffer.from([0]));
  const validExistingHash = await hashFile(databasePath);
  requireCondition(validExistingHash !== report.resources['Country.mmdb'].sha256 && await hasMetadataTail(databasePath), 'VALID_EXISTING_MMDB_FIXTURE_INVALID');
  peer = new NativePeer(fixture.hostPath);
  response = await peer.request('applyConfig', { config: geoConfiguration() });
  requireCondition(response.ok && response.data.applied, 'VALID_EXISTING_MMDB_CORE_VALIDATION_FAILED');
  await requireWorkingCore(peer, 'VALID_EXISTING_MMDB_CORE_NOT_WORKING');
  const validAfterHash = await hashFile(databasePath);
  requireCondition(validAfterHash === validExistingHash, 'VALID_EXISTING_MMDB_OVERWRITTEN');
  recordCheck('valid_existing_mmdb_preserved', { sha256Before: validExistingHash, sha256After: validAfterHash, distinctFromBundle: true });

  const previousConfigurationHash = await hashFile(configPath);
  const invalid = geoConfiguration();
  invalid.proxies = [{ name: 'fixture-invalid', type: 'not-a-supported-proxy', server: '127.0.0.1', port: 39001 }];
  response = await peer.request('applyConfig', { config: invalid });
  requireCondition(!response.ok, 'INVALID_CANDIDATE_ACCEPTED');
  requireCondition(await hashFile(configPath) === previousConfigurationHash, 'INVALID_CANDIDATE_CHANGED_SAVED_CONFIGURATION');
  await requireWorkingCore(peer, 'INVALID_CANDIDATE_STOPPED_WORKING_CORE');
  recordCheck('invalid_candidate_preserves_configuration_and_running_core');
  requireCondition(await peer.close() && await waitForPortsClosed(), 'FINAL_EOF_CORE_CLEANUP_FAILED');
  recordCheck('eof_exits_host_and_closes_isolated_core_ports');
}

async function findFrameworkCompiler() {
  const windows = process.env.WINDIR || 'C:\\Windows';
  for (const architecture of ['Framework64', 'Framework']) {
    const compiler = path.join(windows, 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe');
    if (await fileExists(compiler)) return compiler;
  }
  throw new Error('WINDOWS_FRAMEWORK_COMPILER_MISSING');
}

async function testDamagedDat(fixture) {
  const names = ['GeoIP.dat', 'GeoSite.dat'];
  const config = geoConfiguration();
  config['geodata-mode'] = true;
  config.rules = ['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,DIRECT'];
  // If repair fails, these deliberately unavailable local sources cannot hide
  // the problem by downloading replacement databases during the test.
  config['geox-url'] = { geoip: 'http://127.0.0.1:1/ip', geosite: 'http://127.0.0.1:1/site' };
  for (const kind of ['empty', 'truncated']) {
    for (const [index, name] of names.entries()) {
      const source = await fs.readFile(path.join(resourceRoot, name));
      const damaged = kind === 'empty' ? Buffer.alloc(index) : source.subarray(0, Math.floor(source.length / 2));
      await fs.writeFile(path.join(fixture.dataRoot, name), damaged);
    }
    const peer = new NativePeer(fixture.hostPath);
    const result = await peer.request('applyConfig', { config });
    requireCondition(result.ok && result.data.applied, 'DAMAGED_DAT_RECOVERY_FAILED');
    await requireWorkingCore(peer, 'DAMAGED_DAT_CORE_NOT_WORKING');
    for (const name of names) requireCondition(await hashFile(path.join(fixture.dataRoot, name)) === report.resources[name].sha256, 'DAMAGED_DAT_NOT_REPAIRED');
    const logs = await peer.request('readLogs');
    requireCondition(logs.ok && !logs.data.lines.some(line => /start download|remove and download/i.test(line)), 'DAT_REPAIR_TRIGGERED_NETWORK_DOWNLOAD');
    requireCondition(await peer.close() && await waitForPortsClosed(), 'DAT_EOF_CORE_CLEANUP_FAILED');
    recordCheck(kind + '_dat_resources_repaired_and_geo_rules_validate_offline', { fileCount: 2, geoipAndGeosite: true });
  }

  function firstRecordEnd(bytes, start) {
    requireCondition(bytes[start] === 0x0A, 'DAT_VALID_FIXTURE_TAG_INVALID');
    let offset = start + 1, length = 0, shift = 0;
    while (true) {
      const value = bytes[offset++];
      length += (value & 0x7F) * 2 ** shift;
      if (!(value & 0x80)) break;
      shift += 7;
      requireCondition(shift <= 28, 'DAT_VALID_FIXTURE_LENGTH_INVALID');
    }
    return offset + length;
  }
  const hashes = {};
  for (const name of names) {
    const source = await fs.readFile(path.join(resourceRoot, name));
    const first = firstRecordEnd(source, 0), second = firstRecordEnd(source, first);
    // Swapping complete independent entries preserves protobuf and rule data,
    // while a distinct hash reveals accidental replacement by the bundle.
    const reordered = Buffer.concat([source.subarray(first, second), source.subarray(0, first), source.subarray(second)]);
    const destination = path.join(fixture.dataRoot, name);
    await fs.writeFile(destination, reordered);
    hashes[name] = await hashFile(destination);
    requireCondition(hashes[name] !== report.resources[name].sha256, 'VALID_DAT_FIXTURE_HASH_NOT_DISTINCT');
  }
  const peer = new NativePeer(fixture.hostPath);
  const result = await peer.request('applyConfig', { config });
  requireCondition(result.ok && result.data.applied, 'VALID_EXISTING_DAT_CORE_VALIDATION_FAILED');
  await requireWorkingCore(peer, 'VALID_DAT_CORE_NOT_WORKING');
  for (const name of names) requireCondition(await hashFile(path.join(fixture.dataRoot, name)) === hashes[name], 'VALID_EXISTING_DAT_OVERWRITTEN');
  requireCondition(await peer.close() && await waitForPortsClosed(), 'VALID_DAT_EOF_CORE_CLEANUP_FAILED');
  recordCheck('valid_existing_dat_resources_preserved', { fileCount: 2, distinctFromBundle: true, actualCoreValidation: true });
}

async function testColdRollback(fixture) {
  const nativeRoot = fixturePath('stub', 'native');
  await fs.mkdir(path.join(nativeRoot, 'bin'), { recursive: true });
  await fs.mkdir(path.join(nativeRoot, 'geodata'), { recursive: true });
  await fs.mkdir(path.join(nativeRoot, 'data'), { recursive: true });
  const hostPath = path.join(nativeRoot, 'EdgeLink.Host.exe');
  await fs.copyFile(fixture.hostPath, hostPath);
  for (const name of resourceNames) await fs.copyFile(path.join(resourceRoot, name), path.join(nativeRoot, 'geodata', name));
  const stubSource = path.join(nativeRoot, 'FailureCore.cs');
  const stubExecutable = path.join(nativeRoot, 'bin', 'mihomo.exe');
  await fs.writeFile(stubSource, 'using System; using System.Threading; internal static class FailureCore { private static int Main(string[] args) { foreach (string arg in args) { if (arg == "-t") { Thread.Sleep(300); return 0; } } Thread.Sleep(350); return 2; } }', 'utf8');
  await runCompiler(await findFrameworkCompiler(), ['/nologo', '/target:exe', '/langversion:5', `/out:${stubExecutable}`, stubSource], 'ROLLBACK_STUB_COMPILE_FAILED');
  const configPath = path.join(nativeRoot, 'data', 'config.json');
  const original = Buffer.from(' {\n  "mode": "direct",\n  "fixture": "retained"\n}\n', 'utf8');
  await fs.writeFile(configPath, original);
  const originalHash = await hashFile(configPath);
  const peer = new NativePeer(hostPath);
  const response = await peer.request('applyConfig', { config: geoConfiguration() });
  requireCondition(!response.ok, 'START_FAILURE_STUB_WAS_ACCEPTED');
  requireCondition(await hashFile(configPath) === originalHash, 'START_FAILURE_DID_NOT_RESTORE_ORIGINAL_CONFIGURATION');
  const status = await peer.request('status');
  requireCondition(status.ok && !status.data.running, 'START_FAILURE_LEFT_CORE_RUNNING');
  const files = await fs.readdir(path.join(nativeRoot, 'data'));
  requireCondition(!files.some(name => name.startsWith('config.rollback-')), 'SUCCESSFUL_ROLLBACK_LEFT_BACKUP');
  requireCondition(await peer.close() && await waitForPortsClosed(), 'STUB_EOF_CLEANUP_FAILED');
  recordCheck('cold_start_failure_restores_original_configuration', { validatorReturnedSuccess: true, coreExitedDuringStartup: true, restoredByteForByte: true });
}

async function cleanup() {
  let allExited = true;
  for (const peer of [...hosts]) {
    try { await peer.close(); } catch { allExited = false; }
  }
  report.cleanup.allHostsExited = allExited && hosts.size === 0;
  report.cleanup.testPortsClosed = await waitForPortsClosed();
  if (temporaryRoot) {
    validateTemporaryRoot();
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      report.cleanup.temporaryDirectoryRemoved = !await fileExists(temporaryRoot);
    } catch {
      report.cleanup.temporaryDirectoryRemoved = false;
    }
  }
}

try {
  requireCondition(process.platform === 'win32', 'WINDOWS_ONLY_TEST');
  await readResources();
  await requireTestPortsFree();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  validateTemporaryRoot();
  const fixture = await prepareRealHost();
  await testRealCore(fixture);
  await testDamagedDat(fixture);
  await testColdRollback(fixture);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  // Only an allowlisted test code is emitted; no raw native response, stderr,
  // exception stack, configuration body, node name, or URL reaches the report.
  report.failureCode = /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'ISOLATED_TEST_IO_FAILURE';
  process.exitCode = 1;
} finally {
  await cleanup();
  if (report.status === 'passed' && (!report.cleanup.allHostsExited || !report.cleanup.testPortsClosed || !report.cleanup.temporaryDirectoryRemoved)) {
    report.status = 'failed';
    report.failureCode = 'ISOLATED_CLEANUP_INCOMPLETE';
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - startedAt;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`NATIVE_GEODATA_TEST_${report.status.toUpperCase()}`);
  if (report.failureCode) console.log(report.failureCode);
}
