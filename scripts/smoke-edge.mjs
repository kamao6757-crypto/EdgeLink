// A real Edge / native-host integration check with an explicitly local test proxy.
// The proxy is a test fixture, never evidence of a working remote VPN node.
import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = resolve('output/playwright');
await mkdir(output, { recursive:true });
const id = (await readFile('native/extension-id.txt','utf8')).trim();
const extUrl = 'chrome-extension://' + id + '/';
const report = { browser:'Microsoft Edge', startedAt:new Date().toISOString(), localFixture:true, steps:[], errors:[], screenshots:[] };
function passed(name, extra = {}) { report.steps.push({name,ok:true,...extra}); console.log('PASS ' + name); }
let revision = 1;
const sockets = new Set();
const seen = [];
const connectSeen = [];
const fixture = http.createServer((req,res) => {
  if (req.url?.startsWith('/subscription')) {
    res.setHeader('Content-Type','application/json');
    res.setHeader('Subscription-Userinfo','upload=128; download=1024; total=1073741824');
    res.end(JSON.stringify({
      proxies:[
        {name:'本地测试 A（非远程 VPN）',type:'http',server:'127.0.0.1',port:18081,username:'demo',password:'test-only'},
        {name:'本地测试 B（非远程 VPN）',type:'http',server:'127.0.0.1',port:18081,username:'demo',password:'test-only'},
        ...(revision > 1 ? [{name:'离线更新新增测试节点',type:'http',server:'127.0.0.1',port:18081}] : [])
      ],
      'proxy-groups':[{name:'PROXY',type:'select',proxies:['本地测试 A（非远程 VPN）','本地测试 B（非远程 VPN）','DIRECT']}],
      rules:['MATCH,PROXY'],
      // Deliberately unsafe listeners must be overridden by the host.
      'allow-lan':true, 'mixed-port':19999, 'external-controller':'0.0.0.0:19998', tun:{enable:true},
    }));
  } else { res.writeHead(404); res.end(); }
});
const proxy = http.createServer((req,res) => {
  seen.push({url:req.url,auth:req.headers['proxy-authorization'] === 'Basic ' + Buffer.from('demo:test-only').toString('base64')});
  if (req.url?.includes('edgelink-test.example')) {
    if (req.url.includes('generate_204')) { res.writeHead(204); res.end(); }
    else { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end('<!doctype html><title>EdgeLink local proxy verification</title><h1>EDGELINK_PROXY_PATH_OK</h1><p>Local test fixture. This is not a remote VPN.</p>'); }
    return;
  }
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  const upstream = http.request(target,{method:req.method,headers:{...req.headers,'proxy-authorization':undefined}}, response=>{res.writeHead(response.statusCode,response.headers); response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();}); req.pipe(upstream);
});
const origin = http.createServer((req,res) => {
  seen.push({url:req.url,origin:true});
  if (req.url.includes('generate_204')) { res.writeHead(204); res.end(); }
  else { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end('<!doctype html><title>EdgeLink local proxy verification</title><h1>EDGELINK_PROXY_PATH_OK</h1><p>Local test fixture. This is not a remote VPN.</p>'); }
});
proxy.on('connect',(req,client,head)=>{
  connectSeen.push(req.url);
  seen.push({url:req.url,auth:req.headers['proxy-authorization'] === 'Basic ' + Buffer.from('demo:test-only').toString('base64'),connect:true});
  const split = req.url.lastIndexOf(':');
  const isFixture = req.url.slice(0,split) === 'edgelink-test.example';
  const upstream = net.connect(isFixture ? 18082 : Number(req.url.slice(split+1)),isFixture ? '127.0.0.1' : req.url.slice(0,split));
  sockets.add(upstream); upstream.on('close',()=>sockets.delete(upstream));
  upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head.length)upstream.write(head); upstream.pipe(client);client.pipe(upstream);});
  upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
});
for (const server of [fixture,proxy,origin]) server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
fixture.listen(18080,'127.0.0.1'); proxy.listen(18081,'127.0.0.1');origin.listen(18082,'127.0.0.1');
await Promise.all([once(fixture,'listening'),once(proxy,'listening'),once(origin,'listening')]);
let context;
let page;
async function message(command,payload={}) {
  const result = await page.evaluate(async({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});
  if (!result?.ok) throw new Error(result?.error || 'No extension response');
  return result.data;
}
async function idle() { await page.waitForFunction(()=>!document.querySelector('#page')?.hasAttribute('aria-busy')); }
async function go(route) { await page.goto(extUrl+'dashboard.html#'+route); await page.waitForFunction(route=>document.querySelector('#page')?.dataset.route === route && !document.querySelector('.loading'),route); }
async function screenshot(file) { await page.screenshot({path:resolve(output,file),fullPage:true});report.screenshots.push(file); }

try {
  context = await chromium.launchPersistentContext(resolve(output,'edge-profile-'+Date.now()),{
    channel:'msedge',headless:false,viewport:{width:1440,height:1000},
    args:['--load-extension='+resolve('extension'),'--disable-extensions-except='+resolve('extension'),'--no-first-run'],
    ignoreDefaultArgs:['--disable-extensions']
  });
  report.browserVersion = context.browser().version();
  page = await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  await go('home');
  assert.match(await page.title(),/EdgeLink/);
  const initial = await message('snapshot');
  assert.equal(initial.enabled,false);
  passed('Actual Edge loaded the unpacked Manifest V3 extension',{version:report.browserVersion,id});
  await screenshot('01-home-initial.png');

  await go('settings');
  await page.locator('#settings-form input[name=autoDetect]').uncheck();
  await page.locator('#test-url').fill('http://edgelink-test.example/generate_204');
  await page.locator('#settings-form button[type=submit]').click();
  await idle();
  assert.equal((await message('snapshot')).settings.autoDetect,false);
  passed('Preferences save through real extension messaging');

  await go('subscriptions');
  await page.locator('#subscription-name').fill('本地集成测试（非远程 VPN）');
  await page.locator('#subscription-url').fill('http://127.0.0.1:18080/subscription?token=fixture-token');
  await page.locator('#subscription-form button[type=submit]').click();
  await idle();
  const imported = await message('snapshot');
  const sub = imported.subscriptions.find(x=>x.name==='本地集成测试（非远程 VPN）');
  assert.ok(sub); assert.equal(sub.proxyCount,2); assert.ok(!sub.source.includes('fixture-token'));
  passed('URL configuration import, header usage parsing and URL token masking');
  await page.locator('[data-action=activate][data-id="'+sub.id+'"]').click();
  await idle();
  const active = await message('snapshot',{page:'proxies'});
  assert.equal(active.core.running,true);
  assert.ok(active.proxies['本地测试 A（非远程 VPN）']);
  assert.equal(active.activeSubscriptionId,sub.id);
  const nativeConfig = JSON.parse(await readFile('native/data/config.json','utf8'));
  assert.equal(nativeConfig['mixed-port'],17890);assert.equal(nativeConfig['allow-lan'],false);assert.equal(nativeConfig.tun.enable,false);
  passed('Native Messaging starts real Mihomo and applies the imported configuration safely',{coreVersion:active.core.version});

  await go('proxies');
  await page.locator('[data-action=select][data-name="本地测试 B（非远程 VPN）"]').click();
  await idle();
  assert.equal((await message('snapshot',{page:'proxies'})).proxies.PROXY.now,'本地测试 B（非远程 VPN）');
  passed('Node selection changes actual Mihomo selector');
  await message('testProxy',{name:'本地测试 B（非远程 VPN）'});
  const tested = (await message('snapshot',{page:'tests'})).tests.find(x=>x.name==='本地测试 B（非远程 VPN）');
  assert.equal(tested.ok,true,JSON.stringify(tested));assert.ok(tested.delay>=0);
  passed('Measured HTTP latency passes through the local upstream proxy',{delayMs:tested.delay});

  await go('home');
  await page.locator('[data-action=toggle]').click();
  await idle();
  const enabled = await message('snapshot');
  assert.equal(enabled.enabled,true);assert.equal(enabled.levelOfControl,'controlled_by_this_extension');
  const browserSettings = await page.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
  assert.equal(browserSettings.value.mode,'pac_script');
  const probe = await context.newPage();
  await probe.goto('http://edgelink-test.example/through-proxy',{timeout:20000});
  assert.match(await probe.locator('body').innerText(),/EDGELINK_PROXY_PATH_OK/);
  assert.ok(seen.some(x=>x.url.includes('through-proxy')));assert.ok(seen.some(x=>x.url.includes('edgelink-test.example') && x.auth));
  passed('An actual Edge tab traverses PAC → Mihomo → authenticated upstream HTTP proxy');
  await probe.close();

  try {
    const geo = await message('detectGeo');
    assert.ok(geo.ip && geo.country);assert.equal(geo.proxyEnabled,true);
    assert.ok(connectSeen.some(x=>/ipwho\.is|ip\.sb/.test(x)));
    report.realGeo = {ip:geo.ip,country:geo.country,region:geo.region,city:geo.city,source:geo.source,localFixtureExit:true};
    passed('Real exit IP and region fetched over the enabled browser proxy',{source:geo.source});
  } catch(error) {
    report.geoUnavailable = error.message;
    console.log('GEO_UNAVAILABLE ' + error.message);
  }

  await go('rules');
  await page.locator('#rule-value').fill('direct-test.example');
  await page.locator('#rule-form button[type=submit]').click();
  await idle();
  assert.equal((await message('snapshot')).browserRules[0].value,'direct-test.example');
  passed('Browser domain rule is saved and PAC is regenerated');

  await message('stop');
  const cleared = await page.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
  assert.notEqual(cleared.levelOfControl,'controlled_by_this_extension');
  passed('Stopping core releases the extension browser proxy');
  revision = 2;
  await message('updateSubscription',{id:sub.id});
  await message('start');
  const restarted = await message('snapshot',{page:'proxies'});
  assert.ok(restarted.proxies['离线更新新增测试节点']);
  assert.equal(restarted.proxies.PROXY.now,'本地测试 B（非远程 VPN）');
  passed('Offline subscription update is applied on restart; selected node is restored');
  await message('toggleProxy',{enabled:true});
  if (report.realGeo) await message('detectGeo');
  await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));

  // One batched visual inspection round for all shipped pages and compact widths.
  for (const [route,file] of [['home','02-home-configured.png'],['proxies','03-proxies.png'],['subscriptions','04-subscriptions.png'],['connections','05-connections.png'],['rules','06-rules.png'],['logs','07-logs.png'],['tests','08-tests.png'],['settings','09-settings.png']]) {
    await go(route);await screenshot(file);
    const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow,false,'Horizontal overflow '+route);
  }
  await page.setViewportSize({width:430,height:900});
  await go('home');await screenshot('10-home-compact.png');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  const popup = await context.newPage();
  await popup.goto(extUrl+'popup.html');await popup.waitForSelector('.popup-status');
  await popup.setViewportSize({width:350,height:460});await popup.screenshot({path:resolve(output,'11-popup.png')});report.screenshots.push('11-popup.png');
  await popup.close();
  passed('All eight UI pages and popup render without page exceptions or horizontal overflow');
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  await go('logs');
  const coreLogs = (await message('snapshot',{page:'logs'})).coreLogs;
  assert.ok(coreLogs.length);assert.ok(!JSON.stringify(coreLogs).includes('test-only'));
  passed('Real core logs available and credential values redacted');

  const manager = await context.newPage();
  await manager.goto('edge://extensions');
  const info = await manager.evaluate(async id=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true},xs=>resolve(xs.find(x=>x.id===id)))),id);
  report.manifestErrors = info.manifestErrors;
  report.runtimeErrors = info.runtimeErrors;
  assert.equal(info.manifestErrors.length,0);assert.equal(info.runtimeErrors.length,0);
  passed('Edge extension manager reports zero manifest/runtime errors');
  await manager.close();
  report.ok = true;
} catch(error) {
  report.ok = false;report.failure = error.stack;console.error(error);
  if(page) {try{await page.screenshot({path:resolve(output,'failure.png'),fullPage:true});}catch{}}
  process.exitCode = 1;
} finally {
  if (page) { try { await message('stop'); } catch {} }
  if(context)await context.close();
  for(const socket of sockets)socket.destroy();fixture.close();proxy.close();origin.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output,'edge-smoke-report.json'),JSON.stringify(report,null,2));
  console.log('REPORT '+resolve(output,'edge-smoke-report.json'));
}
