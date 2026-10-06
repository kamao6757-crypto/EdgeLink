import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root)));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.deepEqual(manifest.permissions.sort(), ['proxy', 'storage', 'alarms', 'nativeMessaging', 'declarativeNetRequestWithHostAccess'].sort());
for (const target of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...Object.values(manifest.icons)]) await access(new URL('extension/' + target, root));
// fileURLToPath handles the Chinese Windows workspace path reliably.
const { fileURLToPath } = await import('node:url');
async function checkJs(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = new URL(item.name + (item.isDirectory() ? '/' : ''), dir);
    if (item.isDirectory()) { if (item.name !== 'vendor') await checkJs(file); }
    else if (/\.js$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(file)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const code = await readFile(file, 'utf8');
      assert.ok(!/\beval\s*\(|new Function\s*\(/.test(code));
    }
  }
}
await checkJs(new URL('extension/', root));
for (const file of ['dashboard.html', 'popup.html']) {
  const html = await readFile(new URL('extension/' + file, root), 'utf8');
  assert.ok(!/\son(?:click|load|error)\s*=|<script(?![^>]*\bsrc=)/i.test(html), 'MV3 pages use local external scripts');
}
await access(new URL('native/EdgeLink.Host.exe', root));
await access(new URL('native/bin/mihomo.exe', root));
const geodata = JSON.parse(await readFile(new URL('native/GEODATA-SOURCE.json', root)));
assert.equal(geodata.files.length, 3);
for (const source of geodata.files) {
  assert.ok(['Country.mmdb','GeoIP.dat','GeoSite.dat'].includes(source.file));
  const bytes = await readFile(new URL('native/geodata/' + source.file, root));
  assert.equal(bytes.length, source.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  assert.equal(source.releaseDigestVerified, true);
}
console.log('Manifest, local assets, MV3 scripts, native executables and bundled Geo database digests verified.');
