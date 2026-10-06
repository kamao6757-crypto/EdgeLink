import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadSubscription, subscriptionRequestRule, subscriptionSource } from '../extension/core/subscription-fetch.js';

function rules() {
  const calls = [];
  return { calls, updateSessionRules: async change => { calls.push(change); } };
}

test('subscription client identity is scoped to this extension and the exact server origin', () => {
  const url = 'https://subs.example.test:8443/api/client/test-token?type=clash&token=a.b';
  const rule = subscriptionRequestRule(url, 'fixture');
  assert.deepEqual(rule.action.requestHeaders, [{ header:'user-agent', operation:'set', value:'clash.meta' }]);
  assert.deepEqual(rule.condition.initiatorDomains, ['fixture']);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(rule.condition.requestMethods,['get']);
  assert.equal(rule.condition.urlFilter,'|https://subs.example.test:8443/');
  assert.ok(!JSON.stringify(rule).includes('test-token'));
  const matches = value => value.startsWith(rule.condition.urlFilter.slice(1));
  assert.ok(matches(url));
  assert.ok(matches('https://subs.example.test:8443/redirected-config'));
  assert.ok(!matches(url.replace('example.test','exampleXtest')));
  assert.ok(!matches(url.replace(':8443',':8444')));
});

test('installs the compatible request identity before fetching and removes it after reading', async () => {
  const dnr = rules();
  const result = await downloadSubscription('https://subs.example.test/config', {
    rules:dnr, extensionId:'fixture',
    fetcher:async (url, options) => {
      assert.equal(dnr.calls.length,1);
      assert.equal(options.credentials,'omit');
      return new Response('proxies: []',{headers:{'subscription-userinfo':'upload=12; download=34; total=100; expire=; invalid=1'}});
    }
  });
  assert.equal(result.text,'proxies: []');
  assert.deepEqual(result.usage,{upload:12,download:34,total:100});
  assert.deepEqual(dnr.calls[1],{removeRuleIds:[1001]});
});

test('HTTP failure and timeout remove temporary headers without exposing server body or tokens', async () => {
  for (const fail of [async()=>new Response('secret-token-in-server-error',{status:400}), async()=>{throw new DOMException('private-url','TimeoutError');}]) {
    const dnr = rules();
    await assert.rejects(downloadSubscription('https://subs.example.test/private-token', {rules:dnr,extensionId:'fixture',fetcher:fail}), error=>{
      assert.ok(!error.message.includes('secret-token') && !error.message.includes('private-token') && !error.message.includes('private-url'));
      return true;
    });
    assert.deepEqual(dnr.calls.at(-1),{removeRuleIds:[1001]});
  }
});

test('download limits apply to decoded response bytes even without Content-Length', async () => {
  const dnr = rules();
  await assert.rejects(downloadSubscription('https://subs.example.test/config', {
    rules:dnr,extensionId:'fixture',fetcher:async()=>new Response('a'.repeat(4*1024*1024+1))
  }),/4 MiB/);
  assert.deepEqual(dnr.calls.at(-1),{removeRuleIds:[1001]});
});

test('subscription source hides path credentials and query parameters', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const masked = subscriptionSource('https://subs.example.test:8443/api/v1/client/'+token+'?token=secret');
  assert.equal(masked,'https://subs.example.test:8443/api/v1/client/••••?••••');
  assert.ok(!masked.includes(token) && !masked.includes('secret'));
});
