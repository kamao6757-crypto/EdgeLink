import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, validateSubscriptionUrl } from '../extension/core/subscriptions.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const proxy = (name = 'Local test') => ({ name, type: 'http', server: '127.0.0.1', port: 8123 });
const yaml = `proxies:\n  - name: 本地测试\n    type: http\n    server: 127.0.0.1\n    port: 8123\n`;

test('validates HTTP(S) import URLs and preserves query tokens', () => {
  assert.equal(validateSubscriptionUrl(' https://example.test/sub?token=abc%20def '), 'https://example.test/sub?token=abc%20def');
  assert.equal(validateSubscriptionUrl('http://127.0.0.1:8123/sub'), 'http://127.0.0.1:8123/sub');
  for (const invalid of ['', null, 'file:///test.yaml', 'ftp://example.test/sub', 'https:example.test/sub', 'https://user:pass@example.test/sub', 'https://@example.test/sub', 'https://example.test/sub#hash', 'https://example.test/sub#', 'https://example.test/sub\n?x=1', 'https://example.test/%nothex', 'https://example.test\\sub']) {
    assert.throws(() => validateSubscriptionUrl(invalid));
  }
});

test('imports proxies-only YAML and creates a selector and MATCH rule', () => {
  const result = parseSubscription('\uFEFF' + yaml);
  assert.equal(result.format, 'clash-yaml');
  assert.deepEqual(result.names, ['本地测试']);
  assert.equal(result.proxyCount, 1);
  assert.deepEqual(result.config['proxy-groups'], [{ name: 'PROXY', type: 'select', proxies: ['本地测试', 'DIRECT'] }]);
  assert.deepEqual(result.config.rules, ['MATCH,PROXY']);
});

test('preserves complete JSON configuration and protocol-specific properties', () => {
  const config = {
    mode: 'rule', dns: { enable: true, nameserver: ['https://dns.example.test/dns-query'] },
    proxies: [{ name: 'Future protocol', type: 'wireguard', peers: [{ server: 'example.test', port: 51820 }], 'private-key': 'sample', ip: '172.16.0.2' }],
    'proxy-groups': [{ name: 'Choice', type: 'select', proxies: ['Future protocol', 'DIRECT'] }],
    rules: ['DOMAIN,example.test,DIRECT', 'MATCH,Choice'],
  };
  const result = parseSubscription(JSON.stringify(config));
  assert.equal(result.format, 'clash-json');
  assert.deepEqual(result.config, config);
  assert.doesNotThrow(() => JSON.stringify(result.config));
});

test('imports YAML aliases and standard merge keys with overrides', () => {
  const result = parseSubscription(`defaults: &base\n  type: http\n  server: example.test\n  port: 8080\nproxies:\n  - <<: *base\n    name: Merged\n    port: 8090\n`);
  assert.deepEqual(result.config.proxies[0], { type: 'http', server: 'example.test', port: 8090, name: 'Merged' });
});

test('accepts standard YAML flow mappings and sequences', () => {
  const result = parseSubscription('{proxies: [{name: Flow node, type: http, server: example.test, port: 8080}]}');
  assert.equal(result.format, 'clash-yaml');
  assert.deepEqual(result.names, ['Flow node']);
  assert.equal(parseSubscription('[{name: Flow array, type: http, server: example.test, port: 8080}]').proxyCount, 1);
});

test('accepts remote provider-only configs without fabricating any nodes', () => {
  const result = parseSubscription(`proxy-providers:\n  Subscription:\n    type: http\n    url: https://example.test/nodes.yaml\n    path: ./providers/nodes.yaml\n    interval: 3600\nproxy-groups:\n  - name: All\n    type: select\n    use: [Subscription]\nrules: ["MATCH,All"]\n`);
  assert.equal(result.proxyCount, 0);
  assert.deepEqual(result.names, []);
  assert.equal(result.config['proxy-providers'].Subscription.url, 'https://example.test/nodes.yaml');
  assert.ok(result.warnings.length);
});

test('imports inline proxy providers and counts their known nodes', () => {
  const result = parseSubscription(JSON.stringify({ 'proxy-providers': { Inline: { type: 'inline', payload: [proxy('Inline node')] } } }));
  assert.equal(result.proxyCount, 1);
  assert.deepEqual(result.names, ['Inline node']);
  assert.deepEqual(result.config['proxy-groups'][0].use, ['Inline']);
});

test('parses HTTP, HTTPS and SOCKS5 URIs, including credentials and IPv6', () => {
  const result = parseSubscription('http://user:p%40ss@example.test:80#HTTP\nhttps://secure.example.test#HTTPS\nsocks5://user:pw@[::1]:1080#SOCKS');
  assert.equal(result.format, 'uri-list');
  assert.equal(result.proxyCount, 3);
  assert.deepEqual(result.config.proxies[0], { name: 'HTTP', type: 'http', server: 'example.test', port: 80, username: 'user', password: 'p@ss' });
  assert.deepEqual(result.config.proxies[1], { name: 'HTTPS', type: 'http', server: 'secure.example.test', port: 443, tls: true });
  assert.equal(result.config.proxies[2].type, 'socks5');
  assert.equal(result.config.proxies[2].server, '::1');
});

test('decodes base64 and base64url URI lists with Unicode names and whitespace', () => {
  const uri = 'trojan://secret@edge.example.test:443?sni=server.example.test#%E6%97%A5%E6%9C%AC\nhttp://127.0.0.1:8123#Local';
  const encoded = b64(uri).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const result = parseSubscription(encoded.slice(0, 24) + '\n' + encoded.slice(24));
  assert.equal(result.format, 'base64-uri-list');
  assert.deepEqual(result.names, ['日本', 'Local']);
  assert.equal(result.config.proxies[0].password, 'secret');
  assert.equal(result.config.proxies[0].sni, 'server.example.test');
});

test('maps SIP002, plaintext AEAD-2022 and legacy SS credentials', () => {
  const cases = [
    `ss://${b64('aes-128-gcm:p:a/ss').replace(/=+$/, '')}@example.test:8388#SS`,
    'ss://2022-blake3-aes-128-gcm:YWJj%2Bdef%3D%3D@example.test:8388#SS',
    'ss://' + b64('aes-256-gcm:pass@example.test:8388') + '#SS',
  ];
  for (const uri of cases) {
    const result = parseSubscription(uri);
    assert.equal(result.config.proxies[0].type, 'ss');
    assert.equal(result.config.proxies[0].port, 8388);
  }
  assert.equal(parseSubscription(cases[0]).config.proxies[0].password, 'p:a/ss');
  assert.equal(parseSubscription(cases[1]).config.proxies[0].password, 'YWJj+def==');
});

test('maps supported SS plugins and rejects unsupported plugins', () => {
  const auth = b64('aes-128-gcm:password');
  const obfs = parseSubscription(`ss://${auth}@example.test:8388/?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dfront.example.test#SS`);
  assert.equal(obfs.config.proxies[0].plugin, 'obfs');
  assert.deepEqual(obfs.config.proxies[0]['plugin-opts'], { mode: 'tls', host: 'front.example.test' });
  const ws = parseSubscription(`ss://${auth}@example.test:8388/?plugin=v2ray-plugin%3Btls%3Bhost%3Dfront.example.test%3Bpath%3D%2Fws#SS`);
  assert.deepEqual(ws.config.proxies[0]['plugin-opts'], { mode: 'websocket', host: 'front.example.test', path: '/ws', tls: true });
  assert.throws(() => parseSubscription(`ss://${auth}@example.test:8388/?plugin=unsupported#SS`), /插件/);
});

test('maps VMess base64 JSON and WebSocket/TLS options', () => {
  const result = parseSubscription('vmess://' + b64(JSON.stringify({ v: '2', ps: 'VMess test', add: 'example.test', port: '443', id, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'front.example.test', path: '/ws', tls: 'tls', sni: 'front.example.test', alpn: 'h2,http/1.1', fp: 'chrome' })));
  const node = result.config.proxies[0];
  assert.equal(node.uuid, id);
  assert.equal(node.alterId, 0);
  assert.equal(node.tls, true);
  assert.equal(node.servername, 'front.example.test');
  assert.deepEqual(node.alpn, ['h2', 'http/1.1']);
  assert.deepEqual(node['ws-opts'], { path: '/ws', headers: { Host: 'front.example.test' } });
});

test('maps VLESS Reality and gRPC without confusing fingerprints', () => {
  const key = Buffer.alloc(32, 1).toString('base64url');
  const result = parseSubscription(`vless://${id}@example.test:443?security=reality&pbk=${key}&sid=0123abcd&fp=chrome&sni=front.example.test&type=grpc&serviceName=rpc&flow=xtls-rprx-vision#Reality`);
  const node = result.config.proxies[0];
  assert.equal(node.type, 'vless');
  assert.deepEqual(node['reality-opts'], { 'public-key': key, 'short-id': '0123abcd' });
  assert.equal(node['client-fingerprint'], 'chrome');
  assert.equal(node.fingerprint, undefined);
  assert.deepEqual(node['grpc-opts'], { 'grpc-service-name': 'rpc' });
});

test('maps Hysteria2 standard authentication, TLS and obfuscation', () => {
  const result = parseSubscription('hy2://alice:pw%3Asecret@example.test/?sni=front.example.test&insecure=0&obfs=salamander&obfs-password=obfs123#HY2');
  assert.deepEqual(result.config.proxies[0], {
    name: 'HY2', type: 'hysteria2', server: 'example.test', port: 443, password: 'alice:pw:secret',
    sni: 'front.example.test', 'skip-cert-verify': false, obfs: 'salamander', 'obfs-password': 'obfs123',
  });
  assert.throws(() => parseSubscription('hy2://pass@example.test:443?obfs=bad#H'), /混淆/);
  assert.throws(() => parseSubscription('hy2://pass@example.test:443?ech=abc#H'), /ECH/);
  assert.throws(() => parseSubscription('hy2://pass@example.test:1000-2000#H'), /格式无效/);
});

test('warns for unknown URIs and unsupported SOCKS4 while keeping valid nodes', () => {
  const result = parseSubscription('socks4://example.test:1080#Four\nssr://abc\nhttp://example.test:8080#HTTP');
  assert.equal(result.proxyCount, 1);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /SOCKS4/);
  assert.throws(() => parseSubscription('ssr://abc'), /有效节点/);
});

test('reports unknown optional URI parameters without including their values', () => {
  const result = parseSubscription(`vless://${id}@example.test:443?security=tls&type=ws&path=%2Fws&custom=secret-token#V`);
  assert.match(result.warnings[0], /custom/);
  assert.ok(!result.warnings[0].includes('secret-token'));
});

test('refuses duplicate node names and collisions with group names or builtin policies', () => {
  assert.throws(() => parseSubscription('http://a.example.test:8080#Same\nhttp://b.example.test:8080#Same'), /重复/);
  assert.throws(() => parseSubscription(JSON.stringify({ proxies: [proxy('Same')], 'proxy-groups': [{ name: 'Same', type: 'select', proxies: ['DIRECT'] }] })), /重复/);
  assert.throws(() => parseSubscription('http://example.test:8080#DIRECT'), /冲突/);
  assert.throws(() => parseSubscription('http://example.test:8080#PROXY'), /冲突/);
});

test('refuses malformed supported URIs instead of silently dropping them', () => {
  const invalid = [
    'http://example.test:0#Node', 'http://example.test:65536#Node', 'socks5://example.test#Node',
    'ss://YWVzLTEyOC1nY206@example.test:8388#Node', 'vmess://not-valid-base64',
    `vless://${id}@example.test:443?security=unknown#V`, `vless://bad-uuid@example.test:443#V`,
    `vless://${id}@example.test:443?type=kcp#V`, `vless://${id}@example.test:443?security=reality#V`,
    'trojan://secret@example.test:443?allowInsecure=maybe#T', 'trojan://secret@example.test:443?type=ws&type=tcp#T',
    'trojan://secret@example.test:443#bad%zz', 'http://example.test:8080/not-a-proxy#H',
  ];
  for (const uri of invalid) {
    assert.throws(() => parseSubscription(uri), undefined, uri);
    assert.throws(() => parseSubscription(b64(uri)), undefined, 'base64 ' + uri);
  }
  assert.throws(() => parseSubscription('http://example.test:8080#Valid\n' + invalid[0]), /第 2 行/);
});

test('refuses arbitrary text, empty/invalid configs and non-JSON YAML values', () => {
  for (const invalid of ['', 'A random paragraph', '<html><body>Forbidden</body></html>', b64('random text'), 'mode: rule', 'proxies: []', 'proxies: []\nproxies: []', '{"proxies":{}}', 'proxies:\n  - hello', 'proxies:\n  - name: Missing\n    type: http\n', 'proxy-providers:\n  Broken:\n    type: http', 'value: !!js/function function(){}']) {
    assert.throws(() => parseSubscription(invalid), undefined, invalid);
  }
  for (const port of [0, -1, 65536, '1.5', NaN, true]) assert.throws(() => parseSubscription(JSON.stringify({ proxies: [{ ...proxy(), port }] })), /端口/);
});

test('enforces 4 MiB UTF-8 input limits and rejects recursive aliases', () => {
  assert.throws(() => parseSubscription('a'.repeat(4 * 1024 * 1024 + 1)), /4 MiB/);
  assert.throws(() => parseSubscription('中'.repeat(Math.ceil(4 * 1024 * 1024 / 3))), /4 MiB/);
  assert.throws(() => parseSubscription('a: &a\n  self: *a\n' + yaml), /循环/);
});

test('rejects oversized alias expansion and prototype keys', () => {
  const large = 'x'.repeat(256 * 1024);
  assert.throws(() => parseSubscription(`shared: &shared ${large}\nexpanded: [${Array(20).fill('*shared').join(', ')}]\n` + yaml), /4 MiB/);
  assert.throws(() => parseSubscription('{"proxies":[{"name":"N","type":"http","server":"example.test","port":80}],"__proto__":{"polluted":true}}'), /属性名/);
  assert.equal({}.polluted, undefined);
});
