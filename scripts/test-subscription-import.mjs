// The private real subscription comes from the environment and is never printed or saved in reports.
import { chromium } from 'playwright';
import http from 'node:http';
import { once } from 'node:events';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const profile = await mkdtemp(resolve(tmpdir(),'edgelink-import-test-'));
const id = (await readFile('native/extension-id.txt','utf8')).trim();
const extUrl = 'chrome-extension://'+id+'/';
const report = { version:'0.1.1', checks:[], runtimeErrors:[] };
const seen = [];
const fixture = http.createServer((req,res)=>{
  seen.push({path:req.url,ua:req.headers['user-agent']});
  if(req.url==='/ordinary') {res.end('ordinary');return;}
  if(req.headers['user-agent']!=='clash.meta') {res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"unsupported client"}');return;}
  if(req.url==='/redirect') {res.writeHead(302,{Location:'/subscription'});res.end();return;}
  res.writeHead(200,{'Content-Type':'text/plain','subscription-userinfo':'upload=10; download=20; total=1000'});
  res.end('http://127.0.0.1:18081#Local-header-fixture');
});
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
const fixtureUrl = 'http://127.0.0.1:'+fixture.address().port;
let context;
let page;
try {
  context = await chromium.launchPersistentContext(profile,{
    channel:'msedge',headless:false,viewport:{width:1200,height:850},
    args:['--load-extension='+resolve('extension'),'--disable-extensions-except='+resolve('extension'),'--no-first-run'],
    ignoreDefaultArgs:['--disable-extensions']
  });
  report.edgeVersion = context.browser().version();
  page = await context.newPage();
  page.on('pageerror',()=>report.runtimeErrors.push('Extension page exception'));
  await page.goto(extUrl+'dashboard.html#subscriptions');
  await page.waitForFunction(()=>document.querySelector('#page')?.dataset.route==='subscriptions');
  async function send(command,payload={}) {return page.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});}
  const browserFailure = await page.evaluate(async url=>(await fetch(url)).status,fixtureUrl+'/subscription');
  assert.equal(browserFailure,400);
  const imported = await send('importSubscription',{name:'UA-compatible local fixture',url:fixtureUrl+'/subscription'});
  assert.equal(imported.ok,true,imported.error);assert.equal(imported.data.proxyCount,1);
  assert.ok(seen.some(x=>x.path==='/subscription' && x.ua==='clash.meta'));
  assert.equal((await page.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  report.checks.push('Real Edge import sends Mihomo User-Agent and clears the temporary rule');
  const redirected = await send('importSubscription',{name:'Same-origin redirect fixture',url:fixtureUrl+'/redirect'});
  assert.equal(redirected.ok,true,redirected.error);
  assert.equal((await page.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  report.checks.push('Same-origin subscription redirect keeps the compatible client identity');
  await page.evaluate(async url=>fetch(url),fixtureUrl+'/ordinary');
  assert.ok(seen.find(x=>x.path==='/ordinary').ua!=='clash.meta');
  report.checks.push('Ordinary extension requests keep the browser User-Agent');
  if(process.env.EDGELINK_TEST_SUBSCRIPTION_URL) {
    await page.locator('#subscription-name').fill('用户订阅兼容性测试');
    await page.locator('#subscription-url').fill(process.env.EDGELINK_TEST_SUBSCRIPTION_URL);
    await page.locator('#subscription-form button[type=submit]').click();
    await page.waitForFunction(()=>!document.querySelector('#page').hasAttribute('aria-busy'));
    const snapshot = await send('snapshot',{page:'subscriptions'});
    const result = snapshot.data?.subscriptions.find(x=>x.name==='用户订阅兼容性测试');
    assert.ok(result,'Real subscription did not import');
    assert.ok(result.proxyCount>0);
    assert.ok(!result.source.includes(new URL(process.env.EDGELINK_TEST_SUBSCRIPTION_URL).pathname.split('/').at(-1)));
    assert.equal(snapshot.data.core.running,false,'Import must not start or alter the native core');
    assert.equal((await page.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
    report.realSubscription = {imported:true,proxyCount:result.proxyCount,format:result.format,warningCount:result.warnings.length};
    report.checks.push('User-provided URL imports through the real Edge form with masked source and no native-core changes');
  }
  assert.equal(report.runtimeErrors.length,0);
  report.ok = true;
} catch(error) {
  report.ok = false;
  report.error = process.env.EDGELINK_TEST_SUBSCRIPTION_URL ? 'Subscription import check failed; private details omitted' : error.message;
  console.error(report.error);process.exitCode=1;
} finally {
  if(context)await context.close();fixture.closeAllConnections();fixture.close();
  if(dirname(profile)!==resolve(tmpdir()) || !basename(profile).startsWith('edgelink-import-test-')) throw new Error('Unexpected temporary profile path; cleanup refused');
  await rm(profile,{recursive:true,force:true});
  await mkdir('output/diagnostics',{recursive:true});
  await writeFile('output/diagnostics/subscription-import-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
