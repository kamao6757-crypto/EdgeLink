// Download official MetaCubeX databases and validate complete release assets.
// Reads an enabled Windows loopback proxy address; never changes network settings.
// Overrides: --proxy=http://127.0.0.1:PORT, --direct, --force (recheck download).
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const api = 'https://api.github.com/repos/MetaCubeX/meta-rules-dat';
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const argv = process.argv.slice(2);
const forced = argv.includes('--force');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function getProxy() {
  const explicit = argv.find(x => x.startsWith('--proxy='))?.slice(8)
    || process.env.EDGELINK_DOWNLOAD_PROXY;
  if (argv.includes('--direct')) return undefined;
  if (explicit) {
    const parsed = new URL(explicit);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
      throw new Error('Unsupported download proxy protocol');
    }
    return explicit;
  }
  if (process.platform !== 'win32') return undefined;
  try {
    // Return only an enabled HTTP loopback endpoint, without other registry data.
    const command = "$settings = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; if ($settings.ProxyEnable -eq 1) { $match = [regex]::Match([string]$settings.ProxyServer, '(?i)(?:^|;)\\s*(?:http=)?(?:127\\.0\\.0\\.1|localhost):(?<port>\\d+)(?:;|$)'); if ($match.Success) { 'http://127.0.0.1:' + $match.Groups['port'].Value } }";
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 10000, maxBuffer: 4096,
    });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

const proxy = await getProxy();
console.log(proxy ? 'Official downloads: configured proxy route' : 'Official downloads: direct route');

function curlArgs(accept, selectedProxy, timeout = 90) {
  return [
    '--fail', '--silent', '--show-error', '--location',
    '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '10', '--max-time', String(timeout),
    '--header', 'User-Agent: EdgeLink-development', '--header', 'Accept: ' + accept,
    ...(selectedProxy ? ['--proxy', selectedProxy, '--noproxy', ''] : ['--noproxy', '*']),
  ];
}

function safeFailure(error) {
  // execFile's message includes its entire command; never print that message.
  if (typeof error.code === 'number') return 'curl exit ' + error.code;
  return error.name === 'ValidationError' ? 'size or SHA-256 mismatch' : 'transfer failed';
}

async function githubJSON(path) {
  const routes = proxy ? [proxy, undefined] : [undefined];
  for (const route of routes) {
    try {
      const { stdout } = await run(curl, [
        ...curlArgs('application/vnd.github+json', route, 45), api + path,
      ], { windowsHide: true, timeout: 50000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      console.log('Official metadata source unavailable: ' + safeFailure(error));
    }
  }
  throw new Error('Unable to read official GitHub metadata: ' + path);
}

function validate(bytes, asset) {
  const digest = sha256(bytes);
  if (bytes.length !== asset.size || 'sha256:' + digest !== asset.digest) {
    const error = new Error('Official release asset did not match its metadata');
    error.name = 'ValidationError';
    throw error;
  }
  return digest;
}

async function cachedDigest(target, asset) {
  try { return validate(await readFile(target), asset); }
  catch { return undefined; }
}

async function fetchAsset(asset, target, existingDigest) {
  if (existingDigest && !forced) return { digest: existingDigest, cached: true };
  const part = new URL(target.href + '.' + randomUUID() + '.part');
  const sources = [asset.url + '?download=1&edgelink=' + Date.now(), asset.browser_download_url];
  try {
    for (const source of sources) {
      try {
        const { stdout } = await run(curl, [
          ...curlArgs('application/octet-stream', proxy), '--header', 'Cache-Control: no-cache',
          '--output', fileURLToPath(part), '--write-out', '%{http_code}', source,
        ], { windowsHide: true, timeout: 95000, maxBuffer: 65536 });
        if (stdout.trim() !== '200') throw new Error('Incomplete HTTP response');
        const bytes = await readFile(part);
        const digest = validate(bytes, asset);
        // Preserve an identical installed file while a running reader uses it.
        if (digest !== existingDigest) await rename(part, target);
        return { digest, cached: false, retrievedUrl: source };
      } catch (error) {
        console.log('Official asset source unavailable: ' + new URL(source).hostname
          + '/' + asset.name + ' (' + safeFailure(error) + ')');
      }
    }
    throw new Error('Unable to fetch a verified official database: ' + asset.name);
  } finally {
    await unlink(part).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const release = await githubJSON('/releases/latest');
await mkdir(new URL('native/geodata/', root), { recursive: true });
await mkdir(new URL('third-party/', root), { recursive: true });
const records = await Promise.all([
  ['country.mmdb', 'Country.mmdb'], ['geoip.dat', 'GeoIP.dat'], ['geosite.dat', 'GeoSite.dat'],
].map(async ([sourceName, file]) => {
  const asset = release.assets.find(x => x.name === sourceName);
  if (!asset?.digest?.startsWith('sha256:') || !Number.isSafeInteger(asset.size)) {
    throw new Error('Official digest or size missing for ' + sourceName);
  }
  const target = new URL('native/geodata/' + file, root);
  const existing = await cachedDigest(target, asset);
  const result = await fetchAsset(asset, target, existing);
  console.log('Verified official database: ' + file + ' (' + asset.size + ' bytes'
    + (result.cached ? ', existing copy' : ', complete download') + ')');
  return {
    file, sourceName, url: asset.browser_download_url,
    retrievedUrl: result.retrievedUrl || asset.url + '?download=1',
    assetId: asset.id, size: asset.size, sha256: result.digest,
    releaseDigest: asset.digest, releaseDigestVerified: true, updatedAt: asset.updated_at,
  };
}));

const license = await githubJSON('/license');
if (license.encoding !== 'base64' || !license.content || !license.sha) {
  throw new Error('Official database license content is missing');
}
const licenseBytes = Buffer.from(license.content, 'base64');
const blobSha = createHash('sha1').update('blob ' + licenseBytes.length + '\0')
  .update(licenseBytes).digest('hex');
if (licenseBytes.length !== license.size || blobSha !== license.sha) {
  throw new Error('Official database license blob validation failed');
}
await writeFile(new URL('third-party/meta-rules-dat-LICENSE', root), licenseBytes);
console.log('Verified official database license: ' + license.license.spdx_id);

const provenance = {
  repository: 'https://github.com/MetaCubeX/meta-rules-dat',
  retrievedAt: new Date().toISOString(), release: release.tag_name,
  releaseId: release.id, releasePublishedAt: release.published_at, files: records,
  license: {
    file: 'third-party/meta-rules-dat-LICENSE', spdxId: license.license.spdx_id,
    sourceUrl: license.html_url, blobSha, size: licenseBytes.length, sha256: sha256(licenseBytes),
  },
};
const provenanceTarget = new URL('native/GEODATA-SOURCE.json', root);
const provenancePart = new URL(provenanceTarget.href + '.part');
await writeFile(provenancePart, JSON.stringify(provenance, null, 2) + '\n');
await rename(provenancePart, provenanceTarget);
