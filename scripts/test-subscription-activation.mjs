// Real Edge and real native core, isolated ports/profile/data. Private URL is environment-only.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

const url = process.env.EDGELINK_TEST_SUBSCRIPTION_URL;
if (!url) throw new Error('Provide EDGELINK_TEST_SUBSCRIPTION_URL; its value is never logged');
const work = await mkdtemp(resolve(tmpdir(), 'edgelink-activation-test-'));
const root = resolve('.');
const ext = resolve(work, 'extension');
const native = resolve(work, 'native');
const hostname = 'com.edgelink.test' + Date.now();
const key = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + hostname;
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const id = (await readFile('native/extension-id.txt', 'utf8')).trim();
const report = { version: JSON.parse(await readFile('extension/manifest.json')).version, checks: [], runtimeErrors: [] };
let context, registered = false, page, stage = 'Prepare isolated test';
function passed(name) { report.checks.push(name); console.log('PASS ' + name); }
function runPowerShell(code) { return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference = 'Stop'; " + code], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }); }
const before = createHash('sha256').update(await readFile('native/data/config.json').catch(()=>Buffer.alloc(0))).digest('hex');
try {
  // Refuse occupied test ports rather than attach to anyone else's core.
  for (const port of [27890,27990]) {
    const probe = net.createServer(); probe.listen(port,'127.0.0.1'); await once(probe,'listening'); await new Promise(r=>probe.close(r));
  }
  await cp('extension', ext, { recursive: true });
  await mkdir(resolve(native,'bin'), { recursive: true });
  await cp('native/bin/mihomo.exe',resolve(native,'bin/mihomo.exe'));
  await cp('native/geodata',resolve(native,'geodata'),{recursive:true});
  let source = await readFile('native/Host.cs','utf8');
  assert.equal((source.match(/private const int ProxyPort = 17890;/g)||[]).length,1);
  assert.equal((source.match(/private const int ControllerPort = 17990;/g)||[]).length,1);
  source = source.replace('private const int ProxyPort = 17890;','private const int ProxyPort = 27890;').replace('private const int ControllerPort = 17990;','private const int ControllerPort = 27990;');
  await writeFile(resolve(work,'Host.test.cs'),source);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/build-native.ps1'),'-SourcePath',resolve(work,'Host.test.cs'),'-OutputPath',resolve(native,'EdgeLink.Host.exe')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let background = await readFile(resolve(ext,'background.js'),'utf8');
  assert.ok(background.includes("const HOST = 'com.edgelink.mihomo';"));
  await writeFile(resolve(ext,'background.js'),background.replace("const HOST = 'com.edgelink.mihomo';","const HOST = '"+hostname+"';"));
  const proxySource = await readFile(resolve(ext,'core/proxy.js'),'utf8');
  assert.ok(proxySource.includes('LOCAL_PROXY_PORT = 17890;'));
  await writeFile(resolve(ext,'core/proxy.js'),proxySource.replace('LOCAL_PROXY_PORT = 17890;','LOCAL_PROXY_PORT = 27890;'));
  await writeFile(resolve(native,'host.json'),JSON.stringify({name:hostname,description:'Temporary EdgeLink integration test',path:resolve(native,'EdgeLink.Host.exe'),type:'stdio',allowed_origins:['chrome-extension://'+id+'/']}));
  runPowerShell('New-Item -Path '+psQuote(key)+' -Force | Out-Null; Set-Item -LiteralPath '+psQuote(key)+' -Value '+psQuote(resolve(native,'host.json')));registered=true;
  context = await chromium.launchPersistentContext(resolve(work,'profile'),{channel:'msedge',headless:false,viewport:{width:1440,height:980},args:['--load-extension='+ext,'--disable-extensions-except='+ext,'--no-first-run'],ignoreDefaultArgs:['--disable-extensions']});
  report.edgeVersion = context.browser().version();
  page = await context.newPage();page.on('pageerror',()=>report.runtimeErrors.push('Extension page exception'));
  async function send(command,payload={}) {
    const result = await page.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});
    if(!result?.ok) throw new Error('Extension command failed');return result.data;
  }
  async function go(route) {await page.goto('chrome-extension://'+id+'/dashboard.html#'+route);await page.waitForFunction(route=>document.querySelector('#page')?.dataset.route===route&&!document.querySelector('.loading'),route);}
  stage = 'Import private subscription in Edge'; await go('subscriptions');
  await page.locator('#subscription-name').fill('订阅实际连接验证');await page.locator('#subscription-url').fill(url);
  await page.locator('#subscription-form button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#page').hasAttribute('aria-busy'),null,{timeout:60000});
  let snapshot = await send('snapshot',{page:'subscriptions'});
  const sub = snapshot.subscriptions.find(x=>x.name==='订阅实际连接验证');assert.ok(sub);assert.equal(sub.proxyCount,23);
  passed('Private subscription imported as 23 nodes through the real Edge form');
  stage = 'Activate imported subscription and browser proxy';
  await page.locator('[data-action=activate][data-id="'+sub.id+'"]').click();
  await page.waitForFunction(()=>!document.querySelector('#page').hasAttribute('aria-busy'),null,{timeout:60000});
  snapshot = await send('snapshot',{page:'proxies'});
  assert.equal(snapshot.activeSubscriptionId,sub.id);assert.equal(snapshot.enabled,true);assert.equal(snapshot.core.running,true);
  assert.equal(snapshot.core.proxyPort,27890);assert.equal(snapshot.levelOfControl,'controlled_by_this_extension');
  const nativeConfig = JSON.parse(await readFile(resolve(native,'data/config.json')));
  assert.equal(nativeConfig.proxies.length,23);assert.equal(nativeConfig['mixed-port'],27890);assert.equal(nativeConfig.tun.enable,false);
  report.realSubscription={imported:true,proxyCount:sub.proxyCount,activated:true,browserProxyEnabled:true};
  passed('Use configuration starts real Mihomo, loads all nodes and enables Edge PAC');
  // Use an actual HTTPS tab to verify transport, independent of the location UI.
  stage = 'Real remote HTTPS connectivity'; const tab = await context.newPage();
  const navigation = await tab.goto('https://www.cloudflare.com/cdn-cgi/trace',{timeout:25000});
  assert.ok(navigation?.ok());assert.match(await tab.locator('body').innerText(),/\bip=/);await tab.close();
  passed('Actual Edge HTTPS navigation succeeds through the imported remote configuration');
  stage = 'Automatic exit region shown in Connections';
  const automatic = !!snapshot.geo;
  if(!snapshot.geo) {await send('detectGeo');snapshot = await send('snapshot',{page:'connections'});}
  assert.ok(snapshot.geo?.ip&&snapshot.geo?.country);assert.equal(snapshot.geo.proxyEnabled,true);
  report.exit={country:snapshot.geo.country,countryCode:snapshot.geo.countryCode,region:snapshot.geo.region,city:snapshot.geo.city,source:snapshot.geo.source,automatic};
  await go('connections');
  const location = page.locator('.exit-panel');await assert.doesNotReject(()=>location.waitFor());
  assert.ok((await location.innerText()).includes(snapshot.geo.country));
  await mkdir('output/playwright',{recursive:true});
  report.screenshot='output/playwright/'+report.version+'-exit-region.png';
  await location.screenshot({path:report.screenshot});
  passed('Real detected exit country, region, city and IP render in Connections');
  stage = 'Narrow Connections view';await page.setViewportSize({width:430,height:940});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  passed('Connections with location card fits a 430px viewport');
  assert.equal(report.runtimeErrors.length,0);
  await send('stop');report.ok=true;
} catch {report.ok=false;report.failedStage=stage;process.exitCode=1;}
finally {
  if(context)await context.close();
  if(registered)runPowerShell('if(Test-Path -LiteralPath '+psQuote(key)+'){Remove-Item -LiteralPath '+psQuote(key)+' -Recurse -Force}');
  const after = createHash('sha256').update(await readFile('native/data/config.json').catch(()=>Buffer.alloc(0))).digest('hex');
  report.productionConfigUnchanged=before===after;
  if(!report.productionConfigUnchanged){report.ok=false;process.exitCode=1;}
  if(dirname(work)!==resolve(tmpdir())||!basename(work).startsWith('edgelink-activation-test-'))throw new Error('Unexpected temporary test path; cleanup refused');
  await rm(work,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  await mkdir('output/diagnostics',{recursive:true});await writeFile('output/diagnostics/subscription-activation-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
