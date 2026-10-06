import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildProxyConfig } from '../extension/core/proxy.js';
import { normalizeGeo, detectGeo, geoConnectionIds } from '../extension/core/geo.js';

function route(mode, rules, host) {
  const code = buildProxyConfig(mode, rules).pacScript?.data;
  if (!code) return 'DIRECT';
  const context = vm.createContext({ dnsDomainIs: (h,s) => h.endsWith(s), shExpMatch: (h,p) => p === '127.*' && h.startsWith('127.') });
  vm.runInContext(code, context);
  return context.FindProxyForURL('https://' + host, host);
}
test('PAC keeps the native controller reachable and routes other hosts to the managed core', () => {
  for (const mode of ['rule','global']) {
    for (const host of ['localhost','127.0.0.1','127.1.2.3','::1','[::1]']) assert.equal(route(mode,[],host),'DIRECT');
    assert.equal(route(mode,[],'example.com'),'PROXY 127.0.0.1:17890');
  }
});
test('ordered domain rules match exact and true suffix domains without false positives', () => {
  const rules = [{ type:'DOMAIN-SUFFIX',value:'example.com',action:'DIRECT' }];
  for (const host of ['example.com','sub.example.com','SUB.EXAMPLE.COM']) assert.equal(route('rule',rules,host),'DIRECT');
  assert.equal(route('rule',rules,'notexample.com'),'PROXY 127.0.0.1:17890');
  assert.equal(route('global',rules,'example.com'),'PROXY 127.0.0.1:17890');
});
test('PAC input validation prevents code injection', () => {
  assert.throws(() => buildProxyConfig('rule',[{type:'DOMAIN',value:'x"; return "DIRECT',action:'DIRECT'}]));
  assert.throws(() => buildProxyConfig('unknown'));
});
test('geo uses returned IP and country rather than inferring a node name', () => {
  const geo = normalizeGeo('ipwho',{ip:'203.0.113.2',country:'Test Country',country_code:'TC',connection:{isp:'Test ISP'}});
  assert.equal(geo.ip,'203.0.113.2'); assert.equal(geo.isp,'Test ISP');
  assert.throws(() => normalizeGeo('ipwho',{success:false}));
  assert.throws(() => normalizeGeo('ipwho',{ip:'invalid',country:'x'}));
});

test('geo tunnel cleanup matches exact host or sniffed SNI and preserves unrelated connections', () => {
  assert.deepEqual(geoConnectionIds(null), [], 'Mihomo returns null when no connections exist');
  assert.deepEqual(geoConnectionIds(), []);
  assert.deepEqual(geoConnectionIds([
    { id:'ipwho', metadata:{host:'IPWHO.IS.'} },
    { id:'ipsb', metadata:{host:'203.0.113.8',sniffHost:'api.ip.sb'} },
    { id:'download',metadata:{host:'downloads.example.com'} },
    { id:'lookalike',metadata:{host:'ipwho.is.evil.example',sniffHost:'notipwho.is'} },
    { id:'shared-ip',metadata:{host:'203.0.113.8'} },
    { id:'ipwho',metadata:{host:'ipwho.is'} },
    { metadata:{host:'ipwho.is'} }
  ]), ['ipwho','ipsb']);
});
test('geo falls back to the second provider and handles total failure honestly', async () => {
  let count = 0;
  const geo = await detectGeo(async () => { if (++count === 1) throw new Error('offline'); return {ok:true,json:async()=>({ip:'2001:db8::1',country:'Test',city:'City'})}; });
  assert.equal(geo.source,'ipsb'); assert.equal(count,2);
  await assert.rejects(detectGeo(async()=>({ok:false,status:503})),/出口检测失败/);
});
