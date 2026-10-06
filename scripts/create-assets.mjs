import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
await mkdir(new URL('extension/icons/', root), { recursive: true });
let key;
try { key = JSON.parse(await readFile(new URL('extension/manifest.json', root))).key; } catch {}
key ||= generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } }).publicKey.toString('base64');
const id = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
await writeFile(new URL('extension/manifest.json', root), JSON.stringify({
  manifest_version: 3, name: 'EdgeLink · 浏览器代理', version: '0.1.3',
  description: '独立本机 Mihomo 内核，URL 订阅导入、节点切换、规则分流与出口地区检测。',
  minimum_chrome_version: '120', key,
  permissions: ['proxy', 'storage', 'alarms', 'nativeMessaging', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_popup: 'popup.html', default_title: 'EdgeLink', default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } },
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  options_page: 'dashboard.html', incognito: 'not_allowed',
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none';" }
}, null, 2) + '\n');
await writeFile(new URL('native/extension-id.txt', root), id + '\n');
function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type); const n = Buffer.alloc(4); n.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); }
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + .5) / size, ny = (y + .5) / size;
    const ring = Math.abs(Math.hypot(nx - .5, ny - .5) - .285) < .032;
    const route = Math.abs(nx + ny - 1) < .075 && nx > .26 && nx < .74;
    const dot = Math.hypot(nx - .7, ny - .3) < .075 || Math.hypot(nx - .3, ny - .7) < .075;
    const o = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(ring || route || dot ? [239, 245, 255, 255] : [51, 100, 180, 255], o);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  await writeFile(new URL('extension/icons/icon' + size + '.png', root), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('Extension ID: ' + id);
