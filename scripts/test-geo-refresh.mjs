// Real Edge + real Mihomo. Local TLS fixtures make pooled old/new exits deterministic.
// Fictional fixture countries are regression evidence, not remote VPN evidence.
import { chromium } from 'playwright';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const oldBehavior = process.env.EDGELINK_REPRODUCE_OLD_GEO === '1';
const work = await mkdtemp(resolve(tmpdir(), 'edgelink-geo-refresh-'));
const ext = resolve(work, 'extension'), native = resolve(work, 'native');
const hostname = 'com.edgelink.geotest' + Date.now();
const key = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + hostname;
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const id = (await readFile('native/extension-id.txt', 'utf8')).trim();
const report = { version: JSON.parse(await readFile('extension/manifest.json')).version,
  localFixture: true, oldBehavior, checks: [], runtimeErrors: [] };
const before = createHash('sha256').update(await readFile('native/data/config.json').catch(()=>Buffer.alloc(0))).digest('hex');
const sockets = new Set(), servers = [];
let context, page, registered = false, stage = 'Prepare isolated fixture';
function passed(name) { report.checks.push(name); console.log('PASS ' + name); }
function powershell(code) { return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference = 'Stop'; " + code], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }); }
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
async function send(command, payload = {}) {
  const result = await page.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}), {command,payload});
  if (!result?.ok) throw new Error(result?.error || 'Extension command failed'); return result.data;
}
async function go(route) {
  await page.goto('chrome-extension://' + id + '/dashboard.html#' + route);
  await page.waitForFunction(route => document.querySelector('#page')?.dataset.route === route && !document.querySelector('.loading'), route);
}
async function idle() { await page.waitForFunction(()=>!document.querySelector('#page').hasAttribute('aria-busy'), null, {timeout:30000}); }
try {
  for (const port of [47890,47990]) {
    const probe = net.createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening'); await new Promise(r=>probe.close(r));
  }
  const certPath = resolve(work, 'fixture-cert.pem'), keyPath = resolve(work, 'fixture-key.pem');
  const opensslConfig = resolve(work, 'openssl.cnf');
  await writeFile(opensslConfig, '[req]\ndistinguished_name = dn\n[dn]\n');
  execFileSync('openssl', ['req','-config',opensslConfig,'-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=EdgeLink local regression fixture'], {windowsHide:true,stdio:['ignore','pipe','pipe']});
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  const proxies = [];
  for (const label of ['A','B']) {
    const origin = https.createServer(tls, (req, res) => {
      if (req.headers.host?.startsWith('keepalive.edgelink.test')) {
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        res.write('<!doctype html><title>Local stream fixture</title><p>UNRELATED_STREAM_OPEN</p>');
        const timer = setInterval(()=>res.write(' '), 1000); timer.unref(); res.on('close',()=>clearInterval(timer));
      } else {
        const body = JSON.stringify({success:true,ip:'203.0.113.'+(label==='A'?'1':'2'),country:'Fixture '+label+' (local test)',country_code:'ZZ',region:'Local regression',city:'Test '+label});
        res.writeHead(200, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body);
      }
    });
    origin.keepAliveTimeout = 120000; origin.headersTimeout = 130000;
    const originPort = await listen(origin);
    const proxy = http.createServer((req,res)=>{res.writeHead(403);res.end();});
    proxy.on('connect',(req,client,head)=>{
      if (!['ipwho.is:443','api.ip.sb:443','keepalive.edgelink.test:443'].includes(req.url)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return; }
      const upstream = net.connect(originPort,'127.0.0.1');sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
      upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
      upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    });
    proxies.push({name:'Fixture '+label,type:'http',server:'127.0.0.1',port:await listen(proxy)});
  }
  await cp('extension',ext,{recursive:true});await mkdir(resolve(native,'bin'),{recursive:true});
  await cp('native/bin/mihomo.exe',resolve(native,'bin/mihomo.exe'));
  await cp('native/geodata',resolve(native,'geodata'),{recursive:true});
  let source = await readFile('native/Host.cs','utf8');
  assert.equal((source.match(/private const int ProxyPort = 17890;/g)||[]).length,1);
  assert.equal((source.match(/private const int ControllerPort = 17990;/g)||[]).length,1);
  source = source.replace('private const int ProxyPort = 17890;','private const int ProxyPort = 47890;').replace('private const int ControllerPort = 17990;','private const int ControllerPort = 47990;');
  await writeFile(resolve(work,'Host.test.cs'),source);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/build-native.ps1'),'-SourcePath',resolve(work,'Host.test.cs'),'-OutputPath',resolve(native,'EdgeLink.Host.exe')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let background = await readFile(resolve(ext,'background.js'),'utf8');
  assert.ok(background.includes("const HOST = 'com.edgelink.mihomo';"));
  background = background.replace("const HOST = 'com.edgelink.mihomo';","const HOST = '"+hostname+"';");
  if (oldBehavior) {
    assert.equal((background.match(/    await refreshGeoConnections\(\);/g)||[]).length,1);
    background = background.replace('    await refreshGeoConnections();','    // Reproduce old connection reuse in this disposable test copy only.');
  }
  // Count proxy writes in the disposable copy to prove no implicit off/on cycle.
  background = "globalThis.__geoProxyWrites = 0;\nfor (const method of ['set','clear']) { const original = chrome.proxy.settings[method].bind(chrome.proxy.settings); chrome.proxy.settings[method] = (...args) => { globalThis.__geoProxyWrites++; return original(...args); }; }\n" + background;
  await writeFile(resolve(ext,'background.js'),background);
  const proxySource = await readFile(resolve(ext,'core/proxy.js'),'utf8');assert.ok(proxySource.includes('LOCAL_PROXY_PORT = 17890;'));
  await writeFile(resolve(ext,'core/proxy.js'),proxySource.replace('LOCAL_PROXY_PORT = 17890;','LOCAL_PROXY_PORT = 47890;'));
  await writeFile(resolve(native,'host.json'),JSON.stringify({name:hostname,description:'Temporary EdgeLink geo regression',path:resolve(native,'EdgeLink.Host.exe'),type:'stdio',allowed_origins:['chrome-extension://'+id+'/']}));
  powershell('New-Item -Path '+psQuote(key)+' -Force | Out-Null; Set-Item -LiteralPath '+psQuote(key)+' -Value '+psQuote(resolve(native,'host.json')));registered=true;
  context = await chromium.launchPersistentContext(resolve(work,'profile'),{channel:'msedge',headless:false,viewport:{width:1360,height:940},ignoreHTTPSErrors:true,
    args:['--load-extension='+ext,'--disable-extensions-except='+ext,'--no-first-run','--ignore-certificate-errors'],ignoreDefaultArgs:['--disable-extensions']});
  report.edgeVersion = context.browser().version();page = await context.newPage();page.on('pageerror',()=>report.runtimeErrors.push('Extension page exception'));
  await go('subscriptions');
  const initial = await send('snapshot');await send('settings',{...initial.settings,autoDetect:false});
  const sub = await send('importSubscription',{name:'Local pooled connection regression',text:JSON.stringify({proxies,'proxy-groups':[{name:'PROXY',type:'select',proxies:proxies.map(p=>p.name)}],rules:['MATCH,PROXY']})});
  await send('activateSubscription',{id:sub.id});
  let snapshot = await send('snapshot',{page:'home'});assert.equal(snapshot.enabled,true);
  const worker = context.serviceWorkers().find(x=>x.url().startsWith('chrome-extension://'+id+'/'));
  assert.ok(worker);const proxyWritesBefore = await worker.evaluate(()=>globalThis.__geoProxyWrites);
  stage = 'Open old exit and unrelated stream';
  await send('selectProxy',{group:'PROXY',name:'Fixture A'});await send('detectGeo');
  snapshot = await send('snapshot',{page:'home'});assert.equal(snapshot.geo.country,'Fixture A (local test)');
  assert.ok(snapshot.connections.connections.some(c=>c.metadata?.host==='ipwho.is'));
  passed('Real Edge retains the old geo HTTPS tunnel through fixture A');
  const stream = await context.newPage();await stream.goto('https://keepalive.edgelink.test/stream',{waitUntil:'commit'});
  await stream.waitForFunction(()=>document.body?.textContent.includes('UNRELATED_STREAM_OPEN'));
  snapshot = await send('snapshot',{page:'home'});
  const unrelated = snapshot.connections.connections.find(c=>c.metadata?.host==='keepalive.edgelink.test');assert.ok(unrelated);
  stage = 'Select B and refresh homepage without toggling';
  await go('proxies');await page.locator('[data-action=select][data-group=PROXY][data-name="Fixture B"]').click();await idle();
  await go('home');await page.locator('#refresh-page').click();await idle();
  snapshot = await send('snapshot',{page:'home'});
  if (oldBehavior) {
    assert.equal(snapshot.geo.country,'Fixture A (local test)');report.reproducedOldExit=true;
    passed('Removing only the fix reproduces stale A after choosing B and refreshing');
  } else {
    assert.equal(snapshot.geo.country,'Fixture B (local test)');
    assert.ok((await page.locator('.exit-panel').innerText()).includes('Fixture B (local test)'));
    passed('Homepage top refresh shows current B without toggling proxy');
    assert.ok(snapshot.connections.connections.some(c=>c.id===unrelated.id));
    passed('Refreshing geo keeps the unrelated HTTPS stream alive');
    stage = 'Automatic geo and cross-window homepage synchronization';
    await send('settings',{...snapshot.settings,autoDetect:true});
    const home = await context.newPage();home.on('pageerror',()=>report.runtimeErrors.push('Second homepage exception'));
    await home.goto('chrome-extension://'+id+'/dashboard.html#home');await home.bringToFront();
    await home.waitForFunction(()=>document.querySelector('.exit-panel')?.textContent.includes('Fixture B (local test)'));
    await send('selectProxy',{group:'PROXY',name:'Fixture A'});
    await home.waitForFunction(()=>document.querySelector('.exit-panel')?.textContent.includes('Fixture A (local test)'));
    passed('Automatic detection and an already open homepage follow new A');
    await mkdir('output/playwright',{recursive:true});await home.locator('.exit-panel').screenshot({path:'output/playwright/0.1.3-geo-refresh-local-fixture.png'});
    await go('connections');await page.bringToFront();await send('selectProxy',{group:'PROXY',name:'Fixture B'});
    await page.waitForFunction(()=>document.querySelector('.exit-panel')?.textContent.includes('Fixture B (local test)'));
    await page.locator('[data-action=geo]').click();await idle();
    snapshot = await send('snapshot',{page:'connections'});assert.equal(snapshot.geo.country,'Fixture B (local test)');
    assert.ok(snapshot.connections.connections.some(c=>c.id===unrelated.id));
    passed('Connections detects current B while preserving the unrelated stream');
    await home.bringToFront();
    await home.waitForFunction(()=>document.querySelector('.exit-panel')?.textContent.includes('Fixture B (local test)'));
    passed('A previously hidden homepage shows current B when reopened');
  }
  assert.equal(snapshot.enabled,true);assert.equal(snapshot.core.running,true);
  assert.equal(await worker.evaluate(()=>globalThis.__geoProxyWrites),proxyWritesBefore);
  passed('Proxy settings stay enabled with zero off/on or PAC rewrites during refresh');
  assert.equal(report.runtimeErrors.length,0);report.ok=true;
} catch (error) { report.ok=false;report.failedStage=stage;report.failure=String(error.message).slice(0,500);process.exitCode=1; }
finally {
  if(context){try{await send('stop');}catch{}await context.close();}
  for(const socket of sockets)socket.destroy();
  await Promise.all(servers.map(server=>new Promise(r=>server.close(r))));
  if(registered)powershell('if(Test-Path -LiteralPath '+psQuote(key)+'){Remove-Item -LiteralPath '+psQuote(key)+' -Recurse -Force}');
  const after = createHash('sha256').update(await readFile('native/data/config.json').catch(()=>Buffer.alloc(0))).digest('hex');
  report.productionConfigUnchanged=before===after;if(!report.productionConfigUnchanged){report.ok=false;process.exitCode=1;}
  if(dirname(work)!==resolve(tmpdir())||!basename(work).startsWith('edgelink-geo-refresh-'))throw new Error('Unexpected cleanup path');
  await rm(work,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  await mkdir('output/diagnostics',{recursive:true});
  await writeFile('output/diagnostics/geo-refresh-'+(oldBehavior?'old-reproduction':'report')+'.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
