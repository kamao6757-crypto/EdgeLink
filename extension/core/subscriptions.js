import { load, JSON_SCHEMA } from '../vendor/js-yaml.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const builtins = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
const endpointTypes = new Set(['http', 'socks5', 'ss', 'ssr', 'vmess', 'vless', 'trojan', 'snell', 'hysteria', 'hysteria2', 'tuic', 'anytls']);

/** Validate an import URL without fetching it. Local HTTP is useful for private subscriptions. */
export function validateSubscriptionUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请输入订阅 URL。');
  const text = raw.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(text) || /%(?![\da-f]{2})/i.test(text)) {
    throw new Error('订阅 URL 包含非法字符。');
  }
  const authority = text.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined) throw new Error('订阅 URL 仅支持 HTTP 或 HTTPS。');
  let url;
  try { url = new URL(text); } catch { throw new Error('订阅 URL 格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('订阅 URL 仅支持 HTTP 或 HTTPS。');
  }
  if (authority.includes('@') || url.username || url.password) throw new Error('订阅 URL 不支持用户名或密码形式的认证。');
  if (text.includes('#')) throw new Error('订阅 URL 不能包含片段标记。');
  return url.href;
}

/** Parse content only; fetching, core validation and activating a proxy happen elsewhere. */
export function parseSubscription(text) {
  if (typeof text !== 'string') throw new Error('订阅内容必须是文本。');
  if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('订阅内容超过 4 MiB 上限。');
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('订阅内容为空。');

  if (/^[\[{]/.test(source)) {
    let config;
    try { config = JSON.parse(source); } catch { /* Flow-style YAML may also begin with a bracket. */ }
    if (config !== undefined) return finishConfig(config, 'clash-json');
  }

  const lines = contentLines(source);
  if (lines.length && lines.every(({ text: line }) => /^[a-z][\da-z+.-]*:\/\//i.test(line))) {
    return parseUris(lines, 'uri-list');
  }

  // A base64 subscription must decode to URI lines, never arbitrary text or nested encodings.
  if (/^[\da-z+/_=\s-]+$/i.test(source)) {
    try {
      const decoded = decodeBase64(source, true);
      const decodedLines = contentLines(decoded);
      if (decodedLines.length && decodedLines.every(({ text: line }) => /^[a-z][\da-z+.-]*:\/\//i.test(line))) {
        return parseUris(decodedLines, 'base64-uri-list');
      }
    } catch (error) {
      // Valid URI content must retain its specific validation error, rather than falling through to YAML.
      if (error.subscriptionUriError) throw error;
    }
  }

  let config;
  try { config = load(source, { schema: JSON_SCHEMA }); } catch {
    throw new Error('订阅既不是有效的 Clash YAML / JSON，也不是 URI 节点列表。');
  }
  return finishConfig(config, 'clash-yaml');
}

function contentLines(text) {
  return text.split(/\r?\n/).map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(({ text: line }) => line && !line.startsWith('#'));
}

function decodeBase64(value, whitespace = false) {
  const compact = whitespace ? value.replace(/\s/g, '') : value;
  if (!compact || !/^[\da-z+/_-]+={0,2}$/i.test(compact) || compact.length % 4 === 1) {
    throw new Error('Base64 编码无效。');
  }
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const body = normalized.replace(/=+$/, '');
  if (normalized.includes('=') && normalized.length % 4 !== 0) throw new Error('Base64 填充无效。');
  let binary;
  try { binary = atob(body + '='.repeat((4 - body.length % 4) % 4)); } catch {
    throw new Error('Base64 编码无效。');
  }
  if (btoa(binary).replace(/=+$/, '') !== body) throw new Error('Base64 编码无效。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch { throw new Error('Base64 内容不是 UTF-8 文本。'); }
}

function jsonSafe(value) {
  const ancestors = new Set();
  let bytes = 0;
  function spend(count) {
    bytes += count;
    if (bytes > MAX_BYTES) throw new Error('订阅展开后的配置超过 4 MiB 上限。');
  }
  function copy(item, depth = 0) {
    if (depth > 80) throw new Error('订阅配置嵌套过深。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      spend(encoder.encode(JSON.stringify(item)).byteLength + 1);
      return item;
    }
    if (!item || typeof item !== 'object') throw new Error('订阅配置包含不能序列化的值。');
    if (ancestors.has(item)) throw new Error('订阅配置包含循环 YAML 引用。');
    ancestors.add(item);
    spend(2);
    let result;
    if (Array.isArray(item)) result = item.map(child => copy(child, depth + 1));
    else {
      result = Object.create(null);
      // JSON_SCHEMA intentionally disables custom tags. Resolve ordinary YAML merge keys here.
      if (Object.hasOwn(item, '<<')) {
        const sources = Array.isArray(item['<<']) ? item['<<'] : [item['<<']];
        for (const source of sources) {
          if (!isObject(source)) throw new Error('YAML 合并引用必须指向映射。');
          const merged = copy(source, depth + 1);
          for (const [key, child] of Object.entries(merged)) if (!Object.hasOwn(result, key)) result[key] = child;
        }
      }
      for (const [key, child] of Object.entries(item)) {
        if (key === '<<') continue;
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('订阅配置包含不支持的属性名。');
        spend(encoder.encode(JSON.stringify(key)).byteLength + 2);
        result[key] = copy(child, depth + 1);
      }
    }
    ancestors.delete(item);
    return result;
  }
  // Return ordinary JSON objects, without alias references or special prototypes.
  const result = copy(value);
  const serialized = JSON.stringify(result);
  if (encoder.encode(serialized).byteLength > MAX_BYTES) throw new Error('订阅展开后的配置超过 4 MiB 上限。');
  return JSON.parse(serialized);
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validName(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('每个节点和代理组必须有有效名称。');
  }
  if (builtins.has(value)) throw new Error(`名称「${value}」与内置代理策略冲突。`);
  return value;
}

function portNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new Error('节点端口必须是整数。');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('节点端口必须在 1 到 65535 之间。');
  return port;
}

function validateNode(node) {
  if (!isObject(node)) throw new Error('proxies 必须由节点对象组成。');
  validName(node.name);
  if (typeof node.type !== 'string' || !/^[a-z][\da-z-]*$/.test(node.type)) throw new Error('节点协议类型无效。');
  if (Object.hasOwn(node, 'server') && (typeof node.server !== 'string' || !node.server.trim() || /[\s/?#@]/.test(node.server))) {
    throw new Error('节点服务器地址无效。');
  }
  if (Object.hasOwn(node, 'port')) node.port = portNumber(node.port);
  if (endpointTypes.has(node.type)) {
    if (!node.server || (!node.port && !(node.type === 'hysteria2' && node.ports))) throw new Error('节点缺少服务器地址或端口。');
  }
  // Preserve all protocol-specific fields; Mihomo performs authoritative protocol validation.
}

function finishConfig(input, format, warnings = []) {
  const config = jsonSafe(Array.isArray(input) ? { proxies: input } : input);
  if (!isObject(config)) throw new Error('订阅内容不包含 Clash 配置对象。');
  if (Object.hasOwn(config, 'proxies') && !Array.isArray(config.proxies)) throw new Error('proxies 必须是数组。');
  const proxies = config.proxies || [];
  const names = [];
  const policyNames = new Set();
  const addNode = node => {
    validateNode(node);
    if (policyNames.has(node.name)) throw new Error(`节点名称重复：「${node.name}」。`);
    policyNames.add(node.name);
    names.push(node.name);
  };
  proxies.forEach(addNode);

  const providers = config['proxy-providers'];
  if (providers !== undefined && !isObject(providers)) throw new Error('proxy-providers 必须是对象。');
  const providerNames = Object.keys(providers || {});
  for (const name of providerNames) {
    validName(name);
    const provider = providers[name];
    if (!isObject(provider) || !['http', 'file', 'inline'].includes(provider.type)) throw new Error('代理集类型必须是 http、file 或 inline。');
    if (provider.type === 'http') validateSubscriptionUrl(provider.url);
    if (provider.type === 'file' && (typeof provider.path !== 'string' || !provider.path.trim())) throw new Error('文件代理集缺少路径。');
    if (provider.type === 'inline') {
      if (!Array.isArray(provider.payload) || !provider.payload.length) throw new Error('内联代理集缺少节点。');
      provider.payload.forEach(addNode);
    }
  }
  if (!proxies.length && !providerNames.length) throw new Error('订阅未包含有效节点或代理集。');
  if (providerNames.some(name => providers[name].type !== 'inline')) {
    warnings.push('远程或文件代理集的节点数量将在内核加载后确定。');
  }

  if (config['proxy-groups'] !== undefined && !Array.isArray(config['proxy-groups'])) throw new Error('proxy-groups 必须是数组。');
  if (!config['proxy-groups']?.length) {
    if (policyNames.has('PROXY')) throw new Error('节点名称「PROXY」与默认代理组冲突，请重命名节点。');
    const group = { name: 'PROXY', type: 'select', proxies: [...proxies.map(node => node.name), 'DIRECT'] };
    if (providerNames.length) group.use = providerNames;
    config['proxy-groups'] = [group];
  }
  for (const group of config['proxy-groups']) {
    if (!isObject(group)) throw new Error('proxy-groups 必须由代理组对象组成。');
    validName(group.name);
    if (policyNames.has(group.name)) throw new Error(`节点或代理组名称重复：「${group.name}」。`);
    if (typeof group.type !== 'string' || !group.type) throw new Error('代理组缺少类型。');
    policyNames.add(group.name);
  }
  if (config.rules !== undefined && (!Array.isArray(config.rules) || config.rules.some(rule => typeof rule !== 'string'))) {
    throw new Error('rules 必须是规则字符串数组。');
  }
  if (!config.rules?.length) config.rules = [`MATCH,${config['proxy-groups'][0].name}`];
  return { format, config, proxyCount: names.length, names, warnings };
}

function parseUris(lines, format) {
  const proxies = [];
  const warnings = [];
  for (const { text: uri, line } of lines) {
    const protocol = uri.slice(0, uri.indexOf('://')).toLowerCase();
    if (!['http', 'https', 'socks5', 'socks5h', 'ss', 'vmess', 'trojan', 'vless', 'hysteria2', 'hy2'].includes(protocol)) {
      warnings.push(protocol === 'socks4' || protocol === 'socks4a'
        ? `第 ${line} 行：Mihomo 不支持 SOCKS4 出站，已跳过。`
        : `第 ${line} 行：不支持 ${protocol} URI，已跳过；此协议可尝试完整 Clash 配置。`);
      continue;
    }
    try {
      if (/[\u0000-\u0020\u007f]/.test(uri) || /%(?![\da-f]{2})/i.test(uri)) throw new Error('URI 包含非法字符或百分号编码。');
      if (protocol === 'vmess') proxies.push(parseVmess(uri));
      else if (protocol === 'ss') proxies.push(parseShadowsocks(uri));
      else proxies.push(parseStandardUri(uri, protocol, warnings, line));
    } catch (cause) {
      const error = new Error(`第 ${line} 行 ${protocol} 节点无效：${cause.message}`);
      error.subscriptionUriError = true;
      throw error;
    }
  }
  if (!proxies.length) {
    const error = new Error('订阅没有可转换的有效节点。' + (warnings[0] || ''));
    error.subscriptionUriError = true;
    throw error;
  }
  try { return finishConfig({ proxies }, format, warnings); } catch (error) {
    error.subscriptionUriError = true;
    throw error;
  }
}

function decodePart(value, label) {
  try { return decodeURIComponent(value); } catch { throw new Error(`${label} 编码无效。`); }
}

function endpoint(uri, defaultPort) {
  const body = uri.slice(uri.indexOf('://') + 3);
  const authority = body.split(/[/?#]/, 1)[0];
  if ((authority.match(/@/g) || []).length > 1) throw new Error('认证信息中的 @ 必须进行百分号编码。');
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const portMatch = hostPort.match(/:(\d+)$/);
  if (hostPort.endsWith(':')) throw new Error('节点端口为空。');
  let url;
  try { url = new URL(`http://${body}`); } catch { throw new Error('URI 地址格式无效。'); }
  if (!url.hostname) throw new Error('节点缺少服务器地址。');
  const port = portNumber(portMatch ? portMatch[1] : defaultPort);
  const server = url.hostname.replace(/^\[|\]$/g, '');
  const hashName = decodePart(url.hash.slice(1), '名称');
  const name = hashName || `${uri.slice(0, uri.indexOf('://')).toUpperCase()} ${server}:${port}`;
  if (url.pathname && url.pathname !== '/') throw new Error('节点 URI 路径必须通过传输参数 path 指定。');
  const keys = new Set();
  for (const key of url.searchParams.keys()) {
    if (keys.has(key)) throw new Error('URI 包含重复的查询参数。');
    keys.add(key);
  }
  return { url, server, port, name, username: decodePart(url.username, '认证信息'), password: decodePart(url.password, '认证信息') };
}

function queryBool(value, label) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${label} 必须是 0 / 1 或 true / false。`);
}

function getParam(params, ...names) {
  const present = names.filter(name => params.has(name));
  if (present.length > 1) throw new Error('URI 中同义参数重复。');
  return present.length ? params.get(present[0]) : undefined;
}

function applyTls(node, params, security) {
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error('不支持此 TLS 安全类型，请使用完整 Clash 配置。');
  if (node.type === 'trojan' && security === 'none') throw new Error('Trojan 节点必须使用 TLS。');
  if (node.type !== 'trojan') node.tls = security !== 'none';
  const sni = getParam(params, 'sni', 'servername', 'serverName');
  if (sni) node[node.type === 'trojan' ? 'sni' : 'servername'] = sni;
  const insecure = getParam(params, 'allowInsecure', 'insecure', 'skip-cert-verify');
  if (insecure !== undefined) node['skip-cert-verify'] = queryBool(insecure, '跳过证书验证');
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',').map(item => item.trim()).filter(Boolean);
  if (params.get('fp')) node['client-fingerprint'] = params.get('fp');
  if (security === 'reality') {
    const publicKey = params.get('pbk');
    if (!publicKey || !/^[\da-z_-]{43}=?$/i.test(publicKey)) throw new Error('Reality 节点缺少有效的公钥 pbk。');
    const shortId = params.get('sid') || '';
    if (!/^(?:[\da-f]{2}){0,8}$/i.test(shortId)) throw new Error('Reality short-id 无效。');
    node['reality-opts'] = { 'public-key': publicKey, 'short-id': shortId };
  }
}

function applyTransport(node, { network = 'tcp', host, path, serviceName, headerType }) {
  if (network === 'httpupgrade') network = 'ws';
  if (network === 'tcp' && headerType === 'http') network = 'http';
  else if (headerType && headerType !== 'none') throw new Error('不支持此传输伪装，请使用完整 Clash 配置。');
  if (!['tcp', 'ws', 'grpc', 'http', 'h2'].includes(network) || (node.type === 'trojan' && ['http', 'h2'].includes(network))) {
    throw new Error('不支持此 URI 传输类型，请使用完整 Clash 配置。');
  }
  node.network = network;
  if (network === 'ws') {
    node['ws-opts'] = { path: path || '/' };
    if (host) node['ws-opts'].headers = { Host: host };
  } else if (network === 'grpc') {
    node['grpc-opts'] = { 'grpc-service-name': serviceName || '' };
  } else if (network === 'http') {
    node['http-opts'] = { path: [path || '/'] };
    if (host) node['http-opts'].headers = { Host: host.split(',') };
  } else if (network === 'h2') {
    node['h2-opts'] = { path: path || '/' };
    if (host) node['h2-opts'].host = host.split(',');
  }
}

function parseStandardUri(uri, protocol, warnings, line) {
  const defaultPort = protocol === 'http' ? 80 : ['https', 'hysteria2', 'hy2'].includes(protocol) ? 443 : undefined;
  const ep = endpoint(uri, defaultPort);
  const params = ep.url.searchParams;
  const type = protocol === 'https' ? 'http' : ['socks5', 'socks5h'].includes(protocol) ? 'socks5' : ['hy2', 'hysteria2'].includes(protocol) ? 'hysteria2' : protocol;
  const node = { name: ep.name, type, server: ep.server, port: ep.port };
  if (type === 'http' || type === 'socks5') {
    if (ep.username) node.username = ep.username;
    if (ep.password) node.password = ep.password;
    if (protocol === 'https') node.tls = true;
    if (params.has('tls')) node.tls = queryBool(params.get('tls'), 'TLS');
    const insecure = getParam(params, 'allowInsecure', 'insecure', 'skip-cert-verify');
    if (insecure !== undefined) node['skip-cert-verify'] = queryBool(insecure, '跳过证书验证');
    if (params.get('sni')) node.sni = params.get('sni');
  } else if (type === 'hysteria2') {
    if (!ep.username) throw new Error('Hysteria2 节点缺少认证信息。');
    node.password = ep.username + (ep.password ? `:${ep.password}` : '');
    if (params.get('sni')) node.sni = params.get('sni');
    if (params.has('insecure')) node['skip-cert-verify'] = queryBool(params.get('insecure'), '跳过证书验证');
    if (params.get('obfs')) {
      if (!['salamander', 'gecko'].includes(params.get('obfs'))) throw new Error('不支持此 Hysteria2 混淆类型。');
      if (!params.get('obfs-password')) throw new Error('Hysteria2 混淆缺少密码。');
      node.obfs = params.get('obfs');
      node['obfs-password'] = params.get('obfs-password');
    }
    if (params.get('pinSHA256')) node.fingerprint = params.get('pinSHA256');
    if (params.has('ech')) throw new Error('Hysteria2 ECH URI 暂不能转换，请使用完整 Clash 配置。');
  } else {
    if (ep.password) throw new Error('认证信息格式无效，请对密码内的冒号进行百分号编码。');
    if (!ep.username) throw new Error('节点缺少认证信息。');
    if (type === 'trojan') node.password = ep.username;
    else {
      if (!uuidPattern.test(ep.username)) throw new Error('VLESS 节点 UUID 无效。');
      node.uuid = ep.username;
      if (params.get('flow')) {
        if (params.get('flow') !== 'xtls-rprx-vision') throw new Error('不支持此 VLESS flow，请使用完整 Clash 配置。');
        node.flow = params.get('flow');
      }
      if (params.get('encryption') && params.get('encryption') !== 'none') node.encryption = params.get('encryption');
    }
    applyTls(node, params, params.get('security') || (type === 'trojan' ? 'tls' : 'none'));
    const network = params.get('type') || params.get('network') || 'tcp';
    applyTransport(node, { network, host: params.get('host'), path: params.get('path'), serviceName: params.get('serviceName'), headerType: params.get('headerType') });
    if (network === 'httpupgrade') node['ws-opts']['v2ray-http-upgrade'] = true;
    if (params.get('packetEncoding')) {
      if (!['xudp', 'packetaddr'].includes(params.get('packetEncoding'))) throw new Error('packetEncoding 无效。');
      node['packet-encoding'] = params.get('packetEncoding');
    }
  }
  if (params.has('udp')) node.udp = queryBool(params.get('udp'), 'UDP');
  const supported = new Set(type === 'http' || type === 'socks5'
    ? ['tls', 'sni', 'allowInsecure', 'insecure', 'skip-cert-verify', 'udp']
    : type === 'hysteria2'
      ? ['sni', 'insecure', 'obfs', 'obfs-password', 'pinSHA256', 'udp']
      : ['security', 'sni', 'servername', 'serverName', 'allowInsecure', 'insecure', 'skip-cert-verify', 'alpn', 'fp', 'pbk', 'sid', 'type', 'network', 'host', 'path', 'serviceName', 'headerType', 'flow', 'encryption', 'packetEncoding', 'udp']);
  const unknown = [...params.keys()].filter(key => !supported.has(key));
  if (unknown.length) warnings.push(`第 ${line} 行：${protocol} 有未转换参数 ${unknown.join('、')}，请核对或使用完整 Clash 配置。`);
  return node;
}

function parseShadowsocks(uri) {
  let body = uri.slice(5);
  let credentials;
  const at = body.indexOf('@');
  if (at === -1) {
    const fragmentAt = body.indexOf('#');
    const fragment = fragmentAt < 0 ? '' : body.slice(fragmentAt);
    const decoded = decodeBase64(fragmentAt < 0 ? body : body.slice(0, fragmentAt));
    const separator = decoded.lastIndexOf('@');
    if (separator < 1) throw new Error('Shadowsocks Base64 内容缺少服务器地址。');
    credentials = decoded.slice(0, separator);
    body = decoded.slice(separator + 1) + fragment;
  } else {
    const userinfo = body.slice(0, at);
    credentials = userinfo.includes(':') ? decodePart(userinfo, '认证信息') : decodeBase64(decodePart(userinfo, '认证信息'));
    body = body.slice(at + 1);
  }
  const separator = credentials.indexOf(':');
  if (separator < 1 || separator === credentials.length - 1) throw new Error('Shadowsocks 缺少加密方法或密码。');
  const cipher = credentials.slice(0, separator);
  if (!/^[\da-z-]+$/.test(cipher)) throw new Error('Shadowsocks 加密方法无效。');
  const ep = endpoint(`ss://${body}`);
  if (ep.username || ep.password) throw new Error('Shadowsocks URI 认证信息格式无效。');
  const node = { name: ep.name, type: 'ss', server: ep.server, port: ep.port, cipher, password: credentials.slice(separator + 1) };
  for (const key of ep.url.searchParams.keys()) if (!['plugin', 'udp'].includes(key)) throw new Error('Shadowsocks URI 包含不能转换的参数，请使用完整 Clash 配置。');
  if (ep.url.searchParams.has('udp')) node.udp = queryBool(ep.url.searchParams.get('udp'), 'UDP');
  if (ep.url.searchParams.has('plugin')) applySsPlugin(node, ep.url.searchParams.get('plugin'));
  return node;
}

function applySsPlugin(node, value) {
  // SIP002 plugin values escape semicolons, equals signs and backslashes with a backslash.
  const tokens = [];
  let token = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === ';') { tokens.push(token); token = ''; }
    else token += char;
  }
  if (escaped) throw new Error('Shadowsocks 插件参数转义无效。');
  tokens.push(token);
  const plugin = tokens.shift();
  const opts = Object.create(null);
  for (const item of tokens) {
    if (!item) continue;
    const split = item.indexOf('=');
    const key = split === -1 ? item : item.slice(0, split);
    if (!key || Object.hasOwn(opts, key)) throw new Error('Shadowsocks 插件参数重复或无效。');
    opts[key] = split === -1 ? true : item.slice(split + 1);
  }
  if (['obfs-local', 'simple-obfs', 'obfs'].includes(plugin)) {
    if (!['http', 'tls'].includes(opts.obfs)) throw new Error('Shadowsocks obfs 插件需要 http 或 tls 模式。');
    if (Object.keys(opts).some(key => !['obfs', 'obfs-host'].includes(key))) throw new Error('Shadowsocks obfs 插件包含不支持的参数。');
    node.plugin = 'obfs';
    node['plugin-opts'] = { mode: opts.obfs };
    if (opts['obfs-host']) node['plugin-opts'].host = opts['obfs-host'];
  } else if (plugin === 'v2ray-plugin') {
    if (opts.server || (opts.mode && opts.mode !== 'websocket')) throw new Error('仅支持 v2ray-plugin 客户端 WebSocket 模式。');
    if (Object.keys(opts).some(key => !['mode', 'tls', 'host', 'path', 'mux'].includes(key))) throw new Error('v2ray-plugin 包含不支持的参数。');
    node.plugin = 'v2ray-plugin';
    node['plugin-opts'] = { mode: 'websocket' };
    for (const key of ['host', 'path']) if (typeof opts[key] === 'string') node['plugin-opts'][key] = opts[key];
    for (const key of ['tls', 'mux']) if (opts[key] !== undefined) node['plugin-opts'][key] = opts[key] === true ? true : queryBool(opts[key], key);
  } else throw new Error('不支持此 Shadowsocks 插件，请使用完整 Clash 配置。');
}

function parseVmess(uri) {
  const body = uri.slice(8);
  if (!body || /[?#]/.test(body)) throw new Error('VMess URI 必须包含 Base64 JSON。');
  let data;
  try { data = JSON.parse(decodeBase64(body)); } catch { throw new Error('VMess Base64 JSON 无效。'); }
  if (!isObject(data) || typeof data.add !== 'string' || !data.add.trim()) throw new Error('VMess 缺少服务器地址。');
  if (typeof data.id !== 'string' || !uuidPattern.test(data.id)) throw new Error('VMess UUID 无效。');
  const port = portNumber(data.port);
  const alterId = data.aid === undefined || data.aid === '' ? 0 : Number(data.aid);
  if (!Number.isInteger(alterId) || alterId < 0 || alterId > 65535 || (data.aid !== undefined && data.aid !== '' && !/^\d+$/.test(String(data.aid)))) {
    throw new Error('VMess alterId 无效。');
  }
  const cipher = data.scy || 'auto';
  if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'].includes(cipher)) throw new Error('VMess 加密方法无效。');
  const node = { name: data.ps || `VMESS ${data.add}:${port}`, type: 'vmess', server: data.add, port, uuid: data.id, alterId, cipher };
  const params = new URLSearchParams();
  for (const key of ['sni', 'alpn', 'fp', 'allowInsecure', 'insecure']) if (data[key] !== undefined && data[key] !== '') params.set(key, String(data[key]));
  const tls = data.tls === true ? 'tls' : data.tls === false || !data.tls ? 'none' : data.tls;
  applyTls(node, params, tls);
  applyTransport(node, { network: data.net || 'tcp', host: data.host, path: data.path, serviceName: data.serviceName || (data.net === 'grpc' ? data.path : undefined), headerType: data.type });
  if (data.net === 'httpupgrade') node['ws-opts']['v2ray-http-upgrade'] = true;
  return node;
}
