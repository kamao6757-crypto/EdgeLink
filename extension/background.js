import { parseSubscription, validateSubscriptionUrl } from './core/subscriptions.js';
import { buildProxyConfig } from './core/proxy.js';
import { detectGeo, geoConnectionIds } from './core/geo.js';
import { downloadSubscription, subscriptionSource, SUBSCRIPTION_REQUEST_RULE_ID } from './core/subscription-fetch.js';

const HOST = 'com.edgelink.mihomo';
const DEFAULTS = {
  proxyEnabled: false, mode: 'rule', activeSubscriptionId: '', subscriptions: [], browserRules: [],
  settings: { autoDetect: true, updateHours: 0, testUrl: 'https://www.gstatic.com/generate_204', testTimeout: 5000 },
  geo: null, geoError: '', tests: [], logs: []
};
let state;
let port;
let core = { running: false };
let serial = Promise.resolve();
let requestId = 0;
const pending = new Map();

const ready = (async () => {
  const saved = await chrome.storage.local.get('state');
  state = { ...DEFAULTS, ...saved.state, settings: { ...DEFAULTS.settings, ...saved.state?.settings } };
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (chrome.declarativeNetRequest) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SUBSCRIPTION_REQUEST_RULE_ID] }).catch(() => {});
})();

function redact(message) {
  return String(message).replace(/https?:\/\/[^\s"<>]+/gi, (raw) => {
    try { return subscriptionSource(raw); } catch { return '[链接]'; }
  }).replace(/(password|secret|token|authorization)(\s*[:=]\s*)([^\s,}]+)/gi, '$1$2[已隐藏]');
}

async function save() { await chrome.storage.local.set({ state }); }
async function log(level, message) {
  state.logs = [{ time: new Date().toISOString(), level, message: redact(message), source: 'extension' }, ...state.logs].slice(0, 400);
  await save();
}

function hostError(error) {
  const message = String(error?.message || error || '本机内核通信失败');
  if (/not found|not registered|specified native messaging|host manifest/i.test(message)) return '未安装本机助手。请运行安装包中的「安装本机助手.cmd」，然后重新启动内核。';
  if (/exited|closed|disconnected|communicat/i.test(message)) return '本机助手已断开。请重新启动内核；如持续失败，请查看 native/data/host.log。';
  return redact(message);
}

function attachNative() {
  if (port) return port;
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  current.onMessage.addListener((message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.data); else entry.reject(new Error(hostError(message.error)));
  });
  current.onDisconnect.addListener(() => {
    const error = hostError(chrome.runtime.lastError);
    if (port === current) port = undefined;
    core = { running: false, error };
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(error)); }
    pending.clear();
    if (state?.proxyEnabled) {
      state.proxyEnabled = false;
      state.geo = null; state.geoError = '';
      chrome.proxy.settings.clear({ scope: 'regular' }).then(() => log('error', '内核断开，已释放 Edge 代理。')).catch(() => {});
    }
  });
  return current;
}

function native(command, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机内核操作超时，请查看日志后重试。')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { attachNative().postMessage({ id, command, payload }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(new Error(hostError(error))); }
  });
}

async function restoreSelections(sub) {
  if (!sub?.selections || !Object.keys(sub.selections).length) return;
  const proxies = (await api('/proxies')).proxies || {};
  for (const [group, name] of Object.entries(sub.selections)) {
    if (proxies[group]?.all?.includes(name)) await api('/proxies/' + encodeURIComponent(group), 'PUT', { name });
  }
}

async function startCore(reapply = true) {
  const active = state.subscriptions.find(x => x.id === state.activeSubscriptionId);
  if (reapply && active) {
    await native('applyConfig', { config: active.config }, 60000);
    core = await native('status');
    await api('/configs', 'PATCH', { mode: state.mode });
    await restoreSelections(active);
  } else core = await native('start');
  await log('info', '独立 Mihomo 内核已启动，只监听本机。');
  return core;
}

async function api(path, method = 'GET', body, timeoutMs = 12000) {
  if (!core.running) throw new Error('请先启动本机内核。');
  return native('request', { path, method, body, timeoutMs }, timeoutMs + 10000);
}

async function setProxy(enabled, page = 'home') {
  if (enabled) {
    if (!state.activeSubscriptionId) throw new Error('请先导入订阅并点击「使用此配置」。');
    if (!core.running) await startCore();
    const actual = await chrome.proxy.settings.get({ incognito: false });
    if (['not_controllable', 'controlled_by_other_extensions'].includes(actual.levelOfControl)) {
      throw new Error('Edge 代理正由其他扩展或企业策略控制。请先停用冲突的代理扩展。');
    }
    await api('/configs', 'PATCH', { mode: state.mode });
    await chrome.proxy.settings.set({ value: buildProxyConfig(state.mode, state.browserRules), scope: 'regular' });
    const result = await chrome.proxy.settings.get({ incognito: false });
    if (result.levelOfControl !== 'controlled_by_this_extension') throw new Error('Edge 未授予代理控制权，请检查浏览器策略。');
  } else {
    await chrome.proxy.settings.clear({ scope: 'regular' });
  }
  state.proxyEnabled = enabled;
  state.geo = null; state.geoError = '';
  if (enabled) await chrome.alarms.create('core-health', { periodInMinutes: 0.5 });
  else await chrome.alarms.clear('core-health');
  await log('info', enabled ? 'Edge 浏览器代理已启用。' : '已释放 Edge 代理，恢复浏览器原有网络设置。');
  if (enabled && state.settings.autoDetect) {
    try { await checkGeo(); } catch (error) { await log('warning', error.message); }
  }
  return snapshot(page);
}

async function refreshGeoConnections() {
  if (!core.running || !state.proxyEnabled) return;
  const ownership = await chrome.proxy.settings.get({ incognito: false });
  if (ownership.levelOfControl !== 'controlled_by_this_extension') return;
  // no-store does not discard a pooled HTTPS tunnel from the previous node.
  const active = await api('/connections');
  for (const id of geoConnectionIds(active.connections)) await api('/connections/' + encodeURIComponent(id), 'DELETE');
}

async function checkGeo() {
  let result;
  try {
    await refreshGeoConnections();
    result = await detectGeo();
  }
  catch (error) {
    state.geo = null; state.geoError = redact(error.message);
    await save();
    throw error;
  }
  const ownership = await chrome.proxy.settings.get({ incognito: false });
  result.proxyEnabled = state.proxyEnabled && ownership.levelOfControl === 'controlled_by_this_extension';
  result.mode = state.mode;
  result.routeNote = result.proxyEnabled ? '当前浏览器路径（遵循分流规则）' : '浏览器原有网络路径';
  state.geo = result;
  state.geoError = '';
  await log('info', '出口检测成功：' + result.country + (result.city ? ' · ' + result.city : ''));
  return result;
}

async function fetchConfig(url) {
  const { text, usage } = await downloadSubscription(url);
  return { ...parseSubscription(text), usage };
}

async function importSubscription(payload) {
  const name = String(payload.name || '我的订阅').trim().slice(0, 100);
  const url = payload.url ? validateSubscriptionUrl(payload.url) : '';
  const parsed = url ? await fetchConfig(url) : parseSubscription(payload.text || '');
  const subscription = { id: crypto.randomUUID(), name, url, config: parsed.config, format: parsed.format,
    proxyCount: parsed.proxyCount, names: parsed.names, warnings: parsed.warnings, usage: parsed.usage || {},
    updatedAt: new Date().toISOString(), error: '' };
  state.subscriptions.unshift(subscription);
  try { await save(); } catch (error) { state.subscriptions.shift(); throw error; }
  await log('info', '已导入订阅「' + name + '」：' + parsed.proxyCount + ' 个节点。');
  return publicSubscription(subscription);
}

async function activate(id) {
  const sub = state.subscriptions.find(x => x.id === id);
  if (!sub) throw new Error('订阅不存在，请刷新列表。');
  try {
    await native('applyConfig', { config: sub.config }, 60000);
    core = await native('status');
    await api('/configs', 'PATCH', { mode: state.mode });
    await restoreSelections(sub);
  } catch (error) {
    sub.error = hostError(error);
    await save();
    throw error;
  }
  state.activeSubscriptionId = id;
  sub.error = '';
  state.geo = null; state.geoError = '';
  await log('info', '正在使用配置「' + sub.name + '」。');
  return setProxy(true, 'proxies');
}

async function updateSubscription(id) {
  const sub = state.subscriptions.find(x => x.id === id);
  if (!sub?.url) throw new Error('粘贴导入的配置没有订阅 URL，请重新导入更新内容。');
  try {
    const parsed = await fetchConfig(sub.url);
    if (state.activeSubscriptionId === id && core.running) {
      await native('applyConfig', { config: parsed.config }, 60000);
      await api('/configs', 'PATCH', { mode: state.mode });
      await restoreSelections(sub);
      state.geo = null; state.geoError = '';
    }
    Object.assign(sub, { config: parsed.config, format: parsed.format, proxyCount: parsed.proxyCount, names: parsed.names,
      warnings: parsed.warnings, usage: parsed.usage, updatedAt: new Date().toISOString(), error: '' });
    await log('info', '已更新订阅「' + sub.name + '」。');
    if (state.activeSubscriptionId === id && state.proxyEnabled && state.settings.autoDetect) {
      try { await checkGeo(); } catch (error) { await log('warning', error.message); }
    }
  } catch (error) { sub.error = redact(error.message); await save(); throw error; }
  return publicSubscription(sub);
}

function publicSubscription(sub) {
  let source = '本地粘贴导入';
  if (sub.url) source = subscriptionSource(sub.url);
  return { id: sub.id, name: sub.name, source, canUpdate: !!sub.url, format: sub.format,
    proxyCount: sub.proxyCount, warnings: sub.warnings, usage: sub.usage, updatedAt: sub.updatedAt,
    error: sub.error, active: sub.id === state.activeSubscriptionId };
}

async function snapshot(page = 'home') {
  const ownership = await chrome.proxy.settings.get({ incognito: false });
  if (port) {
    try { core = { ...core, ...await native('status', {}, 10000) }; } catch (error) { core = { running: false, error: error.message }; }
  }
  const controlled = ownership.levelOfControl === 'controlled_by_this_extension';
  if (!core.running && state.proxyEnabled) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    state.proxyEnabled = false;
    state.geo = null; state.geoError = '';
    await save();
  }
  const result = { core, enabled: state.proxyEnabled && controlled && core.running,
    levelOfControl: ownership.levelOfControl, mode: state.mode, activeSubscriptionId: state.activeSubscriptionId,
    subscriptions: state.subscriptions.map(publicSubscription), settings: state.settings,
    browserRules: state.browserRules, geo: state.geo, geoError: state.geoError, tests: state.tests, logs: state.logs };
  if (core.running) {
    try {
      if (['home', 'proxies', 'tests'].includes(page)) result.proxies = (await api('/proxies')).proxies || {};
      if (['home', 'connections'].includes(page)) result.connections = await api('/connections');
      if (page === 'rules') result.coreRules = (await api('/rules')).rules || [];
      if (page === 'logs') {
        const response = await native('readLogs');
        result.coreLogs = (response.lines || []).slice(-300).reverse().map(line => ({
          time: line.match(/time="([^"]+)"/)?.[1] || '', level: /level=error|level=fatal/.test(line) ? 'error' : /level=warn/.test(line) ? 'warning' : 'info',
          message: redact(line), source: 'core'
        }));
      }
    } catch (error) { result.core.error = error.message; }
  }
  return result;
}

async function runTest(name) {
  const started = performance.now();
  let record;
  try {
    const answer = await api('/proxies/' + encodeURIComponent(name) + '/delay?timeout=' + state.settings.testTimeout + '&url=' + encodeURIComponent(state.settings.testUrl), 'GET', undefined, state.settings.testTimeout + 3000);
    if (!Number.isFinite(answer.delay) || answer.delay < 0) throw new Error('节点未返回有效延迟');
    record = { name, ok: true, delay: answer.delay, checkedAt: new Date().toISOString() };
  } catch (error) { record = { name, ok: false, delay: null, error: redact(error.message), elapsed: Math.round(performance.now() - started), checkedAt: new Date().toISOString() }; }
  state.tests = [record, ...state.tests.filter(x => x.name !== name)].slice(0, 300);
  await save();
  return record;
}

async function dispatch(command, payload) {
  await ready;
  switch (command) {
    case 'snapshot': return snapshot(payload.page);
    case 'start': return startCore();
    case 'stop': {
      await setProxy(false);
      if (port) { await native('shutdown'); port?.disconnect(); port = undefined; }
      core = { running: false };
      await log('info', '本机内核已停止。');
      return snapshot();
    }
    case 'toggleProxy': return setProxy(!!payload.enabled);
    case 'detectGeo': return checkGeo();
    case 'importSubscription': return importSubscription(payload);
    case 'activateSubscription': return activate(payload.id);
    case 'updateSubscription': return updateSubscription(payload.id);
    case 'deleteSubscription': {
      if (payload.id === state.activeSubscriptionId) throw new Error('当前配置正在使用，请先使用另一个配置后再删除。');
      state.subscriptions = state.subscriptions.filter(x => x.id !== payload.id);
      await save(); return true;
    }
    case 'selectProxy': {
      await api('/proxies/' + encodeURIComponent(payload.group), 'PUT', { name: String(payload.name) });
      const active = state.subscriptions.find(x => x.id === state.activeSubscriptionId);
      if (active) active.selections = { ...active.selections, [payload.group]: String(payload.name) };
      state.geo = null; state.geoError = '';
      await log('info', '「' + payload.group + '」已切换到「' + payload.name + '」。');
      if (state.proxyEnabled && state.settings.autoDetect) { try { await checkGeo(); } catch (error) { await log('warning', error.message); } }
      return snapshot('proxies');
    }
    case 'mode': {
      if (!['rule', 'global', 'direct'].includes(payload.mode)) throw new Error('无效代理模式');
      if (core.running) await api('/configs', 'PATCH', { mode: payload.mode });
      const previous = state.mode;
      state.mode = payload.mode;
      try { if (state.proxyEnabled) await chrome.proxy.settings.set({ value: buildProxyConfig(state.mode, state.browserRules), scope: 'regular' }); }
      catch (error) { state.mode = previous; if (core.running) await api('/configs', 'PATCH', { mode: previous }); throw error; }
      state.geo = null; state.geoError = ''; await save();
      if (state.proxyEnabled && state.settings.autoDetect) { try { await checkGeo(); } catch (error) { await log('warning', error.message); } }
      return snapshot(payload.page);
    }
    case 'testProxy': return runTest(String(payload.name));
    case 'closeConnection': await api('/connections/' + encodeURIComponent(payload.id), 'DELETE'); return true;
    case 'closeAllConnections': await api('/connections', 'DELETE'); return true;
    case 'addRule': {
      const next = [...state.browserRules, { id: crypto.randomUUID(), type: payload.type, value: String(payload.value || '').trim().toLowerCase(), action: payload.action }];
      const config = buildProxyConfig(state.mode, next);
      if (state.proxyEnabled) await chrome.proxy.settings.set({ value: config, scope: 'regular' });
      state.browserRules = next; await save(); return next;
    }
    case 'deleteRule': {
      const next = state.browserRules.filter(x => x.id !== payload.id);
      if (state.proxyEnabled) await chrome.proxy.settings.set({ value: buildProxyConfig(state.mode, next), scope: 'regular' });
      state.browserRules = next; await save(); return next;
    }
    case 'settings': {
      const url = validateSubscriptionUrl(payload.testUrl);
      if (![0, 6, 12, 24].includes(Number(payload.updateHours))) throw new Error('无效更新频率');
      const timeout = Number(payload.testTimeout);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 20000) throw new Error('测试超时必须在 1000 至 20000 毫秒之间');
      state.settings = { autoDetect: !!payload.autoDetect, updateHours: Number(payload.updateHours), testUrl: url, testTimeout: timeout };
      await chrome.alarms.clear('subscription-update');
      if (state.settings.updateHours) await chrome.alarms.create('subscription-update', { periodInMinutes: state.settings.updateHours * 60 });
      await save(); return state.settings;
    }
    case 'clearLogs': state.logs = []; await save(); return true;
    default: throw new Error('不支持的操作');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const prefix = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(prefix)) return;
  const task = serial.then(() => dispatch(message.command, message.payload || {}));
  serial = task.catch(() => {});
  task.then(data => respond({ ok: true, data }), async error => {
    await ready;
    try { await log('error', error.message); } catch { /* Storage errors must still respond. */ }
    respond({ ok: false, error: hostError(error) });
  });
  return true;
});

chrome.proxy.onProxyError.addListener(async details => {
  await ready;
  if (state.proxyEnabled) await log('error', '浏览器代理错误：' + details.error);
});

chrome.proxy.settings.onChange.addListener(async details => {
  await ready;
  if (state.proxyEnabled && details.levelOfControl !== 'controlled_by_this_extension') {
    state.proxyEnabled = false; state.geo = null; state.geoError = '';
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await log('warning', 'Edge 代理控制权发生变化，请检查其他代理扩展。');
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'core-health') {
    serial = serial.then(async () => {
      await ready;
      if (!state.proxyEnabled) { await chrome.alarms.clear('core-health'); return; }
      try {
        const status = await native('status', {}, 10000);
        if (status.running) { core = status; return; }
      } catch { /* A disconnected or dead core must release its browser proxy. */ }
      state.proxyEnabled = false; state.geo = null; state.geoError = ''; core = { running: false };
      await chrome.proxy.settings.clear({ scope: 'regular' });
      await chrome.alarms.clear('core-health');
      await log('error', '检测到内核停止，已释放 Edge 代理。');
    }).catch(() => {});
    return;
  }
  if (alarm.name !== 'subscription-update') return;
  serial = serial.then(async () => {
    await ready;
    for (const sub of state.subscriptions.filter(x => x.url)) {
      try { await updateSubscription(sub.id); } catch (error) { await log('warning', '订阅自动更新失败：' + error.message); }
    }
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  serial = serial.then(async () => {
    await ready;
    if (state.proxyEnabled) {
      try { await startCore(); await setProxy(true); }
      catch (error) { await setProxy(false); await log('error', error.message); }
    }
  }).catch(() => {});
});
