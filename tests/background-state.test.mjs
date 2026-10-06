import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseSubscription, validateSubscriptionUrl } from '../extension/core/subscriptions.js';
import { buildProxyConfig } from '../extension/core/proxy.js';
import { geoConnectionIds } from '../extension/core/geo.js';
import { downloadSubscription, subscriptionSource, SUBSCRIPTION_REQUEST_RULE_ID } from '../extension/core/subscription-fetch.js';

// Run the production message handlers; only Chrome, HTTP and the native host are mocked.
const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?$/gm, '');
const clone = value => JSON.parse(JSON.stringify(value));
const config = name => ({
  mode: 'rule',
  proxies: [{ name, type: 'socks5', server: '127.0.0.1', port: 1080 }],
  'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: [name, 'DIRECT'] }],
  rules: ['MATCH,PROXY']
});

function event() {
  const listeners = [];
  return {
    addListener: listener => listeners.push(listener),
    emit: (...args) => Promise.all(listeners.map(listener => listener(...args)))
  };
}

function createHarness(t, { names = ['Old'], proxyEnabled = false, autoDetect = false } = {}) {
  const saved = {
    state: {
      proxyEnabled, mode: 'global', activeSubscriptionId: names[0],
      subscriptions: names.map(name => ({
        id: name, name, url: `https://subscriptions.example.test/${name}?token=fixture`,
        config: config(name), selections: { PROXY: 'DIRECT', Removed: 'Gone' },
        warnings: [], usage: {}
      })),
      settings: { autoDetect }
    }
  };
  const model = {
    running: false, config: config(names[0]), selections: {}, applied: [],
    ownProxy: proxyEnabled ? buildProxyConfig('global') : null, otherProxy: false,
    clears: 0, onRequest: null, startupTask: null, geoChecks: 0, geoError: '', applyError: '', commands: [], connections: [], deletedConnections: [], connectionError: '', connectionErrorMethod: ''
  };
  const onMessage = event(), onStartup = event(), onChange = event();
  const nativeMessage = event(), nativeDisconnect = event();
  let nativeQueue = Promise.resolve();
  const ownership = () => model.otherProxy ? 'controlled_by_other_extensions'
    : model.ownProxy ? 'controlled_by_this_extension' : 'controllable_by_this_extension';

  function handleNative({ command, payload }) {
    model.commands.push(command);
    if (command === 'start') { model.running = true; return { running: true }; }
    if (command === 'status') return { running: model.running };
    if (command === 'applyConfig') {
      if (model.applyError) throw new Error(model.applyError);
      model.config = clone(payload.config);
      model.running = true;
      model.applied.push(model.config.proxies[0].name);
      model.selections = Object.fromEntries(model.config['proxy-groups'].map(group => [group.name, group.proxies[0]]));
      return { applied: true };
    }
    if (command === 'request') {
      if (payload.path.startsWith('/connections') && model.connectionError && payload.method === model.connectionErrorMethod) throw new Error(model.connectionError);
      if (payload.path === '/configs' && payload.method === 'PATCH') {
        Object.assign(model.config, payload.body); return {};
      }
      if (payload.path === '/proxies') return { proxies: {
        ...Object.fromEntries(model.config.proxies.map(node => [node.name, node])),
        ...Object.fromEntries(model.config['proxy-groups'].map(group => [group.name, {
          all: group.proxies, now: model.selections[group.name]
        }]))
      } };
      if (payload.path.startsWith('/proxies/') && payload.method === 'PUT') {
        model.selections[decodeURIComponent(payload.path.slice('/proxies/'.length))] = payload.body.name;
        return {};
      }
      if (payload.path === '/connections' && payload.method === 'GET') return { connections: clone(model.connections), downloadTotal: 0, uploadTotal: 0 };
      if (payload.path.startsWith('/connections/') && payload.method === 'DELETE') {
        const id = decodeURIComponent(payload.path.slice('/connections/'.length));
        model.deletedConnections.push(id);
        model.connections = model.connections.filter(connection => connection.id !== id);
        return {};
      }
    }
    throw new Error(`Unexpected native request: ${command} ${payload.path || ''}`);
  }

  const chrome = {
    declarativeNetRequest: { updateSessionRules: async () => {} },
    storage: { local: {
      get: async () => clone(saved), set: async value => { saved.state = clone(value.state); },
      setAccessLevel: async () => {}
    } },
    proxy: { settings: {
      get: async () => ({ levelOfControl: ownership() }),
      set: async ({ value }) => { model.ownProxy = clone(value); },
      clear: async () => { model.ownProxy = null; model.clears++; }, onChange
    }, onProxyError: event() },
    runtime: {
      id: 'fixture', getURL: () => 'chrome-extension://fixture/', onMessage, onStartup,
      connectNative: () => ({
        onMessage: nativeMessage, onDisconnect: nativeDisconnect,
        postMessage(request) {
          model.onRequest?.(request);
          // Native messages run FIFO, independently of extension event handlers.
          nativeQueue = nativeQueue.then(async () => {
            try { await nativeMessage.emit({ id: request.id, ok: true, data: handleNative(request) }); }
            catch (error) { await nativeMessage.emit({ id: request.id, ok: false, error: error.message }); }
          });
        }
      })
    },
    alarms: { onAlarm: event(), create: async () => {}, clear: async () => true }
  };
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  vm.runInContext(backgroundSource, vm.createContext({
    chrome, parseSubscription, validateSubscriptionUrl, buildProxyConfig, subscriptionSource, SUBSCRIPTION_REQUEST_RULE_ID, geoConnectionIds,
    downloadSubscription: url => downloadSubscription(url, { fetcher: async () => new Response(JSON.stringify(config('New'))), rules: chrome.declarativeNetRequest, extensionId: chrome.runtime.id }),
    detectGeo: async () => {
      model.geoChecks++;
      if (model.geoError) throw new Error(model.geoError);
      if (!autoDetect) throw new Error('Unexpected location request');
      return { ip: '203.0.113.7', country: model.connections.some(connection=>connection.id==='old-geo') ? 'Old route country' : 'Fixture Country', region: 'Fixture Region', city: 'Fixture City', checkedAt: new Date().toISOString() };
    },
    fetch: async () => new Response(JSON.stringify(config('New'))),
    URL, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, performance,
    setTimeout: (...args) => { const timer = setTimeout(...args); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  }));

  async function rawSend(command, payload = {}) {
    const answer = await new Promise(resolve => {
      void onMessage.emit({ command, payload }, {
        id: chrome.runtime.id, url: chrome.runtime.getURL('') + 'dashboard.html'
      }, resolve);
    });
    return answer;
  }
  async function send(command, payload = {}) { const answer = await rawSend(command, payload); assert.equal(answer.ok, true, answer.error); return answer.data; }
  return { saved, model, send, rawSend, onStartup, onChange, nativeDisconnect, ownership };
}

test('using a subscription cold applies it, enables the browser proxy and detects its exit', async t => {
  const h = createHarness(t, { names: ['Old', 'New'], autoDetect: true });
  const result = await h.send('activateSubscription', { id: 'New' });
  assert.equal(result.enabled, true);
  assert.equal(result.activeSubscriptionId, 'New');
  assert.equal(h.model.config.proxies[0].name, 'New');
  assert.ok(!h.model.commands.includes('start'), 'must not start stale saved config before applying the candidate');
  assert.equal(h.model.geoChecks, 1);
  assert.equal(result.geo.country, 'Fixture Country');
  assert.equal(result.geo.proxyEnabled, true);
});

test('failed activation preserves the working subscription and surfaces its safe error', async t => {
  const h = createHarness(t, { names: ['Old', 'Broken'], proxyEnabled: true, autoDetect: true });
  h.model.applyError = 'Mihomo 配置验证失败';
  const answer = await h.rawSend('activateSubscription', { id: 'Broken' });
  assert.equal(answer.ok, false);
  assert.equal(h.saved.state.activeSubscriptionId, 'Old');
  assert.equal(h.saved.state.proxyEnabled, true);
  assert.equal(h.model.config.proxies[0].name, 'Old');
  assert.ok(h.saved.state.subscriptions.find(x => x.id === 'Broken').error);
  assert.equal(h.model.geoChecks, 0);
});

test('unavailable location services do not undo a working activation and show a retryable error', async t => {
  const h = createHarness(t, { autoDetect: true });
  h.model.geoError = '出口检测失败：请检查当前节点，稍后重试。';
  const result = await h.send('activateSubscription', { id: 'Old' });
  assert.equal(result.enabled, true);
  assert.equal(result.geo, null);
  assert.match(result.geoError, /出口检测失败/);
  h.model.geoError = '';
  await h.send('detectGeo');
  assert.equal((await h.send('snapshot')).geoError, '');
});

test('manual exit detection discards the previous tunnel without toggling proxy or closing downloads', async t => {
  const h = createHarness(t, { proxyEnabled: true, autoDetect: true });
  await h.send('start');
  h.model.connections = [
    { id:'old-geo',metadata:{host:'ipwho.is'} },
    { id:'download',metadata:{host:'files.example.com'} }
  ];
  const result = await h.send('detectGeo');
  assert.equal(result.country, 'Fixture Country');
  assert.deepEqual(h.model.deletedConnections, ['old-geo']);
  assert.deepEqual(h.model.connections.map(connection=>connection.id), ['download']);
  assert.equal(h.saved.state.proxyEnabled, true);
  assert.equal(h.model.clears, 0);
});

test('failed geo connection cleanup clears old location and does not report a reused exit', async t => {
  for (const method of ['GET', 'DELETE']) {
    const h = createHarness(t, { autoDetect: true });
    await h.send('activateSubscription', { id: 'Old' });
    assert.ok(h.saved.state.geo);
    h.model.connections = [{ id:'old-geo', metadata:{host:'ipwho.is'} }];
    h.model.connectionError = '检测连接清理失败'; h.model.connectionErrorMethod = method;
    const answer = await h.rawSend('detectGeo');
    assert.equal(answer.ok, false);
    assert.equal(h.saved.state.geo, null);
    assert.match(h.saved.state.geoError, /检测连接清理失败/);
    assert.equal(h.model.geoChecks, 1, 'must not reuse a stale tunnel when cleanup fails');
    assert.equal(h.saved.state.proxyEnabled, true);
  }
});

test('direct geo detection works with the proxy and native core stopped', async t => {
  const h = createHarness(t, { autoDetect: true });
  h.model.connectionError = 'Native controller unavailable'; h.model.connectionErrorMethod = 'GET';
  const result = await h.send('detectGeo');
  assert.equal(result.country, 'Fixture Country');
  assert.equal(result.proxyEnabled, false);
  assert.equal(h.model.running, false);
});

test('mode changes and active subscription updates refresh the detected exit', async t => {
  const h = createHarness(t, { proxyEnabled: true, autoDetect: true });
  await h.send('activateSubscription', { id: 'Old' });
  await h.send('mode', { mode: 'rule', page: 'connections' });
  assert.equal(h.model.geoChecks, 2);
  assert.equal(h.saved.state.geo.mode, 'rule');
  await h.send('updateSubscription', { id: 'Old' });
  assert.equal(h.model.geoChecks, 3);
  assert.equal(h.saved.state.geo.proxyEnabled, true);
});

test('starting after an offline subscription update loads new nodes and restores valid selections', async t => {
  const h = createHarness(t);
  await h.send('updateSubscription', { id: 'Old' });
  assert.equal(h.model.running, false, 'updating offline must not start the core');
  assert.equal(h.saved.state.subscriptions[0].config.proxies[0].name, 'New');
  assert.equal(h.model.config.proxies[0].name, 'Old');

  await h.send('start');
  assert.equal(h.model.config.proxies[0].name, 'New');
  assert.equal(h.model.config.mode, 'global');
  assert.deepEqual(h.model.selections, { PROXY: 'DIRECT' });
});

test('losing proxy ownership releases its saved PAC before another extension is disabled', async t => {
  const h = createHarness(t);
  await h.send('toggleProxy', { enabled: true });
  assert.ok(h.model.ownProxy);
  h.model.otherProxy = true;
  await h.onChange.emit({ levelOfControl: 'controlled_by_other_extensions' });
  assert.equal(h.ownership(), 'controlled_by_other_extensions', 'the competing setting is preserved');
  assert.equal(h.model.ownProxy, null);
  assert.equal(h.saved.state.proxyEnabled, false);

  h.model.otherProxy = false;
  await h.nativeDisconnect.emit();
  const snapshot = await h.send('snapshot');
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.levelOfControl, 'controllable_by_this_extension');
  assert.equal(h.model.clears, 1, 'disconnect must not leave or resurrect a saved PAC');
});

test('startup restoration queues behind activation instead of overwriting the newly active subscription', async t => {
  const h = createHarness(t, { names: ['A', 'B'], proxyEnabled: true });
  h.model.onRequest = request => {
    if (request.command === 'applyConfig' && request.payload.config.proxies[0].name === 'B' && !h.model.startupTask) {
      // Deliver startup while B is being activated, before its active ID is saved.
      h.model.startupTask = h.onStartup.emit();
    }
  };
  await h.send('activateSubscription', { id: 'B' });
  assert.ok(h.model.startupTask, 'the startup event must overlap activation');
  await h.model.startupTask;
  const snapshot = await h.send('snapshot', { page: 'proxies' });
  assert.equal(h.saved.state.activeSubscriptionId, 'B');
  assert.equal(snapshot.activeSubscriptionId, 'B');
  assert.equal(h.model.config.proxies[0].name, 'B');
  assert.ok(h.model.applied.every(name => name === 'B'), 'startup must not reapply the previous subscription');
  assert.equal(snapshot.proxies.PROXY.now, 'DIRECT');
});
