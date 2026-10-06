import { send, downloadJson } from './core/client.js';
import { icon, escape as e, bytes, time, toast } from './ui.js';

const pages = [
  ['home', '首页', 'home', '管理你的浏览器网络连接'],
  ['proxies', '代理', 'proxy', '选择节点与策略组，让连接走向你需要的地方'],
  ['subscriptions', '订阅', 'subscription', '通过 URL 导入配置，所有订阅都保存在本机'],
  ['connections', '连接', 'globe', '查看实际出口地区与独立内核当前处理的网络连接'],
  ['rules', '规则', 'rules', '浏览器分流与订阅中的内核规则'],
  ['logs', '日志', 'logs', '查看操作记录和本机内核日志'],
  ['tests', '测试', 'test', '检测节点延迟、出口 IP 与连接后的地区'],
  ['settings', '设置', 'settings', '管理独立内核与插件偏好']
];
let route = 'home';
let data;
let busy = false;
let loadToken = 0;
let proxyFilter = '';
let logFilter = 'all';
const page = document.getElementById('page');
document.getElementById('scope-label').innerHTML = icon('shield') + '仅管理 Edge 代理';
document.getElementById('refresh-page').innerHTML = icon('refresh');

function button(label, action, extra = '', style = '', ico = '') {
  return `<button type="button" class="button ${style}" data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${label}</button>`;
}
function notice(message, type = '') { return `<div class="notice ${type}">${icon('info')}<p>${message}</p></div>`; }
function empty(title, text, ico = 'proxy', action = '') { return `<div class="empty">${icon(ico)}<h3>${title}</h3><p>${text}</p>${action}</div>`; }
function modes() { return `<div class="segmented" role="group" aria-label="代理模式">${[['rule','规则'],['global','全局'],['direct','直连']].map(([value,label]) => `<button data-action="mode" data-mode="${value}" class="${data.mode === value ? 'selected' : ''}" aria-pressed="${data.mode === value}">${label}</button>`).join('')}</div>`; }
function chosen() {
  const proxies = data.proxies || {};
  const group = data.mode === 'global' ? proxies.GLOBAL : proxies.PROXY || Object.values(proxies).find(x => x.type === 'Selector' && x.name !== 'GLOBAL');
  return group?.now || '未选择';
}
function activeSubscription() { return data.subscriptions.find(x => x.active); }
function coreMissing() { return !data.core.running ? notice('本机内核尚未启动。可在<a href="#settings">设置</a>中启动；首次使用请先运行 EdgeLink 一体安装包。', 'warning') : ''; }
function geoCard(full = false) {
  const geo = data.geo;
  return `<section class="panel exit-panel"><div class="panel-head"><h2>出口地区</h2>${button('检测', 'geo', '', 'small', 'refresh')}</div>
    ${data.geoError ? notice(e(data.geoError), 'warning') : ''}
    <div class="exit-location">${icon('globe')}<div><strong>${geo ? e(geo.country) : '等待检测'}</strong><span>${geo ? e([geo.region,geo.city].filter(Boolean).join(' · ') || '已获取出口位置') : '连接后检测实际出口'}</span></div></div>
    <div class="data-row"><span>公网 IP</span><span>${e(geo?.ip || '—')}</span></div>
    <div class="data-row"><span>${geo ? '检测路径' : '检测时间'}</span><span>${geo ? e(geo.routeNote) : '尚未检测'}</span></div>
    ${full && geo ? `<div class="data-row"><span>网络运营商</span><span>${e(geo.isp || '—')}</span></div><div class="data-row"><span>时区</span><span>${e(geo.timezone || '—')}</span></div><div class="data-row"><span>来源 / 时间</span><span>${e(geo.source)} · ${e(time(geo.checkedAt))}</span></div>` : ''}
  </section>`;
}

function renderHome() {
  const active = activeSubscription();
  const total = data.connections || {};
  const hasSub = data.subscriptions.length > 0;
  return `<div class="home-grid">
    <section class="panel connect-panel"><div><span class="badge ${data.enabled ? 'green' : ''}"><i class="status-dot ${data.enabled ? 'on' : ''}"></i>${data.enabled ? 'Edge 代理已启用' : 'Edge 代理未启用'}</span><h2>${data.enabled ? '连接，由你掌控' : '准备好，连接世界'}</h2><p>${data.enabled ? '当前模式：' + ({rule:'规则分流',global:'全局代理',direct:'直连'}[data.mode]) + '。出口结果以实际检测为准。' : '导入订阅、选择节点，一键启用浏览器代理。'}</p><a class="button small" href="${active ? '#proxies' : '#subscriptions'}">${active ? '选择代理节点' : '导入我的订阅'}${icon('arrow')}</a></div><button class="power-button ${data.enabled ? 'on' : ''}" data-action="toggle" aria-label="${data.enabled ? '关闭 Edge 代理' : '启用 Edge 代理'}" title="${data.enabled ? '关闭 Edge 代理' : '启用 Edge 代理'}">${icon('power')}</button></section>
    ${geoCard()}
  </div>
  <section class="panel strategy"><div><h2>代理模式</h2><p>${active ? e(active.name) + ' · 策略组选择：' + e(chosen()) : '尚未使用配置，先从订阅开始'}</p></div>${modes()}</section>
  ${data.core.error ? notice(e(data.core.error), 'error') : ''}
  <div class="home-bottom"><section class="panel"><div class="panel-head"><h2>运行概况</h2><span class="badge ${data.core.running ? 'green' : 'amber'}">${data.core.running ? '内核运行中' : '内核未启动'}</span></div><dl class="fact-list">
    <div class="fact"><dt>独立内核</dt><dd>${data.core.running ? 'Mihomo ' + e(data.core.version || '') : '等待启动'}</dd></div>
    <div class="fact"><dt>活跃连接</dt><dd>${data.core.running ? e(total.connections?.length || 0) + ' 条' : '—'}</dd></div>
    <div class="fact"><dt>累计下载 / 上传</dt><dd>${data.core.running ? bytes(total.downloadTotal) + ' / ' + bytes(total.uploadTotal) : '—'}</dd></div>
    <div class="fact"><dt>本机代理端口</dt><dd>127.0.0.1:17890</dd></div>
  </dl></section><section class="panel"><h2>${data.enabled ? '连接就绪' : '开始使用'}</h2><p class="hint">三步完成你的浏览器网络配置</p><div class="onboarding">
    <div class="step"><span class="step-marker ${hasSub ? 'done' : ''}">${hasSub ? icon('check') : '1'}</span><div><a href="#subscriptions">导入订阅配置</a><small>${hasSub ? '已导入 ' + data.subscriptions.length + ' 份配置' : 'Clash YAML、节点链接或 Base64 订阅'}</small></div></div>
    <div class="step"><span class="step-marker ${active ? 'done' : ''}">${active ? icon('check') : '2'}</span><div><a href="#subscriptions">使用配置并选择节点</a><small>${active ? e(active.name) : '点击「使用此配置」启动独立内核'}</small></div></div>
    <div class="step"><span class="step-marker ${data.enabled ? 'done' : ''}">${data.enabled ? icon('check') : '3'}</span><div><a href="#tests">启用代理，检测出口</a><small>${data.enabled ? 'Edge 代理已启用，可检测 IP 和地区' : '只管理浏览器，不修改 Windows 系统代理'}</small></div></div>
  </div></section></div>`;
}

function nodeDelay(name, node) {
  const test = data.tests.find(x => x.name === name);
  const history = node?.history?.at(-1);
  if (test && !test.ok) return '<span class="node-delay">超时 / 失败</span>';
  const delay = test?.ok ? test.delay : history?.delay;
  const measured = test?.ok ? Number.isFinite(delay) && delay >= 0 : delay > 0;
  return `<span class="node-delay ${measured && delay < 400 ? 'good' : ''}">${measured ? e(delay) + ' ms' : '未测速'}</span>`;
}
function renderProxies() {
  const proxies = data.proxies || {};
  let groups = Object.entries(proxies).filter(([,x]) => Array.isArray(x.all));
  if (data.mode !== 'global' && groups.length > 1) groups = groups.filter(([name]) => name !== 'GLOBAL');
  return `${coreMissing()}<div class="toolbar"><div class="field search-field">${icon('search')}<input id="proxy-search" aria-label="搜索代理节点" placeholder="搜索节点名称" value="${e(proxyFilter)}"></div>${modes()}</div>
    ${!groups.length ? `<section class="panel">${empty('还没有代理节点', '导入订阅后点击「使用此配置」，这里会显示内核实际加载的节点与策略组。', 'proxy', '<a class="button primary" href="#subscriptions">前往订阅</a>')}</section>` : groups.map(([name,group]) => {
      const names = group.all.filter(n => !proxyFilter || n.toLowerCase().includes(proxyFilter.toLowerCase()));
      return `<section class="panel proxy-group"><div class="panel-head"><div><h2>${e(name)} <span class="badge">${e(group.type)}</span></h2><p>当前：${e(group.now || '—')} · ${group.all.length} 个选项</p></div>${button('测延迟','testGroup',`data-group="${e(name)}"`,'small','test')}</div><div class="proxy-grid">${names.map(n => `<button class="proxy-node ${group.now === n ? 'selected' : ''}" data-action="select" data-group="${e(name)}" data-name="${e(n)}" aria-pressed="${group.now === n}" title="选择 ${e(n)}"><span class="node-icon">${icon(group.now === n ? 'check' : 'globe')}</span><span class="node-info"><span class="node-name">${e(n)}</span><span class="node-type">${e(proxies[n]?.type || '策略')}</span></span>${nodeDelay(n, proxies[n])}</button>`).join('') || '<p class="hint">没有匹配的节点</p>'}</div></section>`;
    }).join('')}`;
}

function renderSubscriptions() {
  return `<section class="panel"><div class="panel-head"><div><h2>导入订阅</h2><p>从你的服务商复制订阅链接</p></div>${icon('subscription')}</div><form id="subscription-form" class="form-stack"><div class="form-row"><div class="field"><label for="subscription-name">配置名称</label><input id="subscription-name" name="name" placeholder="我的订阅" maxlength="100"></div><div class="field"><label for="subscription-url">订阅 URL</label><input id="subscription-url" name="url" type="url" placeholder="https://example.com/subscribe?token=…" required autocomplete="off" spellcheck="false"></div><button class="button primary" type="submit">${icon('plus')}导入配置</button></div></form><p class="form-note">支持 Clash/Mihomo YAML、JSON，以及常见节点链接订阅。链接中的访问令牌只保存在本机。</p><details><summary>或者，粘贴配置内容</summary><form id="paste-form" class="form-stack"><div class="field"><label for="paste-name">配置名称</label><input id="paste-name" name="name" placeholder="本地配置" maxlength="100"></div><div class="field"><label for="paste-text">YAML / 节点链接</label><textarea id="paste-text" name="text" required placeholder="粘贴你的 Clash YAML 或节点链接…" spellcheck="false"></textarea></div><div>${button('导入粘贴内容','pasteSubmit','','primary','upload')}</div></form></details></section>
  <section class="panel"><div class="panel-head"><h2>我的订阅 <span class="badge">${data.subscriptions.length}</span></h2><span class="hint">导入后点击「使用此配置」</span></div>${data.subscriptions.length ? data.subscriptions.map(sub => {
    const usage = sub.usage || {};
    return `<div class="subscription-item"><div><div class="subscription-name"><h3>${e(sub.name)}</h3>${sub.active ? '<span class="badge green">使用中</span>' : ''}</div><div class="source-url">${e(sub.source)}</div><div class="subscription-meta"><span>${sub.proxyCount} 个节点${sub.proxyCount === 0 ? ' · 节点由集合提供' : ''}</span><span>更新于 ${e(time(sub.updatedAt))}</span>${usage.total ? '<span>用量 ' + bytes((usage.upload || 0) + (usage.download || 0)) + ' / ' + bytes(usage.total) + '</span>' : ''}${usage.expire ? '<span>到期 ' + e(time(usage.expire * 1000)) + '</span>' : ''}</div>${sub.error ? '<p class="hint" style="color:var(--red)">' + e(sub.error) + '</p>' : ''}${sub.warnings?.length ? '<p class="hint">' + sub.warnings.map(e).join('；') + '</p>' : ''}</div><div class="actions">${button(sub.active ? '重新应用' : '使用此配置','activate',`data-id="${e(sub.id)}"`, sub.active ? 'small' : 'small primary')}${sub.canUpdate ? button('更新','updateSub',`data-id="${e(sub.id)}"`,'small','refresh') : ''}${!sub.active ? button('删除','deleteSub',`data-id="${e(sub.id)}"`,'small danger') : ''}</div></div>`;
  }).join('') : empty('第一份订阅，从这里开始', '填写上面的订阅 URL，即可导入节点与规则配置。', 'subscription')}</section>`;
}

function renderConnections() {
  const list = data.connections?.connections || [];
  return `${coreMissing()}${data.core.error ? notice(e(data.core.error), 'error') : ''}${geoCard(true)}<section class="panel"><div class="panel-head"><div><h2>活跃连接 <span class="badge">${list.length}</span></h2><p>每 3 秒刷新 · 只显示本插件独立内核中的连接</p></div>${button('关闭全部','closeAll','', 'small danger','close')}</div><div class="connections-total"><span>累计下载 <strong>${bytes(data.connections?.downloadTotal)}</strong></span><span>累计上传 <strong>${bytes(data.connections?.uploadTotal)}</strong></span></div>${list.length ? `<div class="table-wrap"><table><thead><tr><th>目标</th><th>代理链</th><th>规则</th><th>下载 / 上传</th><th>操作</th></tr></thead><tbody>${list.slice(0, 500).map(c => `<tr><td>${e(c.metadata?.host || c.metadata?.destinationIP || '未知目标')}<small>${e(c.metadata?.network || '')} · ${e(c.metadata?.destinationPort || '')}</small></td><td>${e((c.chains || []).join(' → '))}</td><td>${e(c.rule || '—')}<small>${e(c.rulePayload || '')}</small></td><td>${bytes(c.download)} / ${bytes(c.upload)}</td><td>${button('关闭','closeConnection',`data-id="${e(c.id)}"`,'small')}</td></tr>`).join('')}</tbody></table></div>` : empty('暂时没有活跃连接', '启用 Edge 代理后访问网页，当前连接会出现在这里。', 'globe')}${list.length > 500 ? '<p class="hint">显示前 500 条连接</p>' : ''}</section>`;
}

function renderRules() {
  const rules = data.coreRules || [];
  return `<section class="panel"><div class="panel-head"><div><h2>浏览器分流</h2><p>规则模式下按顺序匹配；代理交给内核处理，直连由 Edge 直接访问。</p></div><span class="badge">${data.browserRules.length} 条</span></div><form id="rule-form" class="form-stack"><div class="form-row"><div class="field"><label for="rule-type">匹配方式</label><select id="rule-type" name="type"><option value="DOMAIN-SUFFIX">域名后缀</option><option value="DOMAIN">完整域名</option><option value="DOMAIN-KEYWORD">域名关键词</option></select></div><div class="field"><label for="rule-value">域名或关键词</label><input id="rule-value" name="value" required placeholder="example.com" maxlength="253" spellcheck="false"></div><button class="button primary" type="submit">${icon('plus')}添加规则</button></div><div class="field" style="max-width:200px"><label for="rule-action">匹配后的动作</label><select id="rule-action" name="action"><option value="DIRECT">直连</option><option value="PROXY">交给代理内核</option></select></div></form>${data.browserRules.length ? `<div class="table-wrap result-box"><table><thead><tr><th>类型</th><th>匹配内容</th><th>动作</th><th></th></tr></thead><tbody>${data.browserRules.map(r => `<tr><td>${e(r.type)}</td><td>${e(r.value)}</td><td>${r.action === 'DIRECT' ? '直连' : '代理'}</td><td>${button('删除','deleteRule',`data-id="${e(r.id)}"`,'small')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="form-note">尚无自定义规则。localhost 与回环地址始终直连。</p>'}</section>
  <section class="panel"><div class="panel-head"><div><h2>订阅中的内核规则</h2><p>由当前配置定义 · 在订阅原始配置中编辑后重新导入</p></div><span class="badge">${rules.length} 条</span></div>${rules.length ? `<div class="table-wrap"><table><thead><tr><th>类型</th><th>内容</th><th>策略</th></tr></thead><tbody>${rules.slice(0, 300).map(r => `<tr><td>${e(r.type)}</td><td>${e(r.payload || '所有请求')}</td><td>${e(r.proxy)}</td></tr>`).join('')}</tbody></table></div>${rules.length > 300 ? '<p class="hint">显示前 300 条规则</p>' : ''}` : empty('内核规则将在这里显示', '先使用一份订阅配置。浏览器分流规则会在请求进入内核前生效。', 'rules')}</section>`;
}

function logs() {
  const entries = [...data.logs, ...(data.coreLogs || [])];
  return entries.filter(x => logFilter === 'all' || x.level === logFilter).slice(0, 350);
}
function renderLogs() {
  const entries = logs();
  return `<section class="panel"><div class="panel-head"><div><h2>运行日志</h2><p>包含插件操作记录与内核日志 · 最近 350 条</p></div><div class="actions"><select id="log-filter" aria-label="日志级别">${[['all','全部级别'],['info','信息'],['warning','警告'],['error','错误']].map(([v,l]) => `<option value="${v}" ${logFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${button('导出','exportLogs','','small','download')}${button('清空操作记录','clearLogs','','small')}</div></div>${entries.length ? entries.map(x => `<div class="log-row"><span class="log-time">${x.time ? e(time(x.time)) : '内核日志'}</span><span class="log-level ${e(x.level)}">${e(x.level || 'info')}</span><span class="log-message"><span class="hint">${x.source === 'core' ? '内核 · ' : ''}</span>${e(x.message)}</span></div>`).join('') : empty('暂无日志', '启动内核或导入订阅后，操作记录会出现在这里。', 'logs')}</section>`;
}

function renderTests() {
  const proxies = Object.entries(data.proxies || {}).filter(([name,x]) => !Array.isArray(x.all) && !['DIRECT','REJECT','REJECT-DROP','COMPATIBLE','PASS'].includes(name));
  return `<div class="home-grid">${geoCard(true)}<section class="panel"><div class="panel-head"><h2>连接检查</h2>${icon('shield')}</div><div class="data-row"><span>Edge 代理</span><span>${data.enabled ? '已启用' : '未启用'}</span></div><div class="data-row"><span>本机内核</span><span>${data.core.running ? '运行中' : '未启动'}</span></div><div class="data-row"><span>代理控制权</span><span>${e({controlled_by_this_extension:'本插件',controllable_by_this_extension:'可以接管',controlled_by_other_extensions:'其他扩展',not_controllable:'企业策略'}[data.levelOfControl] || data.levelOfControl)}</span></div><div class="data-row"><span>当前模式</span><span>${e({rule:'规则分流',global:'全局代理',direct:'直连'}[data.mode])}</span></div><p class="form-note">地区来自公网 IP 数据库，代表当前检测请求的出口。规则模式下，不同网站可能使用不同路径。可切换全局模式检测节点出口。</p></section></div>
  <section class="panel result-box"><div class="panel-head"><div><h2>节点延迟</h2><p>实际 HTTP 连通测试 · ${e(data.settings.testUrl)}</p></div>${button('测试全部节点','testAll','','small primary','test')}</div>${proxies.length ? proxies.map(([name,node]) => {
    const result = data.tests.find(x => x.name === name);
    return `<div class="test-row"><div><strong>${e(name)}</strong><small>${e(node.type)}${result ? ' · ' + e(time(result.checkedAt)) : ''}${result?.error ? ' · ' + e(result.error) : ''}</small></div><div class="actions">${nodeDelay(name,node)}${button('测试','testNode',`data-name="${e(name)}"`,'small')}</div></div>`;
  }).join('') : empty('还没有可测试的节点', '使用订阅后，这里会列出内核中的真实节点。', 'test')}</section>`;
}

function renderSettings() {
  const settings = data.settings;
  return `<section class="panel"><div class="panel-head"><div><h2>独立本机内核</h2><p>由本机助手管理，与 Clash Verge 独立运行</p></div><span class="badge ${data.core.running ? 'green' : 'amber'}">${data.core.running ? '运行中' : '未启动'}</span></div><div class="data-row"><span>内核版本</span><span>${data.core.running ? 'Mihomo ' + e(data.core.version || '') : '安装包已附带 Mihomo'}</span></div><div class="data-row"><span>浏览器代理入口</span><span>127.0.0.1:17890</span></div><div class="data-row"><span>本机控制接口</span><span>127.0.0.1:17990</span></div><div class="actions result-box">${data.core.running ? button('停止内核','stop','','danger','power') : button('启动内核','start','','primary','power')}</div>${data.core.error ? '<div class="result-box">' + notice(e(data.core.error),'error') + '</div>' : ''}<details><summary>首次安装与故障排查</summary><ol class="install-steps"><li>将安装包解压到固定目录，运行 <code>安装本机助手.cmd</code>。</li><li>打开 <code>edge://extensions</code>，启用开发人员模式，加载解压后的 <code>extension</code> 文件夹。</li><li>返回插件，点击「启动内核」。如启动失败，查看 <code>native/data/host.log</code>。</li><li>安装后移动文件夹，需要重新运行安装脚本更新路径。</li></ol><p class="hint">启动后只开放本机端口，TUN 与系统代理均不会开启。</p></details></section>
  <section class="panel"><h2>使用偏好</h2><form id="settings-form" class="form-stack"><div><div class="settings-row"><div><h3>连接后自动检测地区</h3><p>启用代理或切换节点后刷新出口信息</p></div><label class="switch"><input type="checkbox" name="autoDetect" ${settings.autoDetect ? 'checked' : ''} aria-label="连接后自动检测地区"></label></div><div class="settings-row"><div><h3>订阅自动更新</h3><p>Edge 运行时定时更新；使用中的配置会重新应用</p></div><select name="updateHours" aria-label="订阅更新频率">${[[0,'手动更新'],[6,'每 6 小时'],[12,'每 12 小时'],[24,'每 24 小时']].map(([v,l]) => `<option value="${v}" ${settings.updateHours === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div><div class="form-grid"><div class="field"><label for="test-url">延迟测试 URL</label><input id="test-url" name="testUrl" type="url" required value="${e(settings.testUrl)}"></div><div class="field"><label for="test-timeout">测试超时（毫秒）</label><input id="test-timeout" name="testTimeout" type="number" min="1000" max="20000" step="500" required value="${e(settings.testTimeout)}"></div></div><div><button class="button primary" type="submit">${icon('check')}保存设置</button></div></form></section>
  <section class="panel"><h2>数据与权限</h2><p class="hint">配置、节点凭据和订阅链接保存在当前 Edge 配置文件的本地存储与本机内核目录中。插件需要网站访问权限以下载任意订阅并检测出口；没有注入网页的脚本。地区检测会向 ipwho.is 或 ip.sb 发起请求。</p><div class="actions">${button('导出脱敏诊断','diagnostics','','small','download')}<span class="hint">不包含订阅 URL、配置内容或节点密码</span></div></section>`;
}

function render() {
  document.getElementById('side-status').innerHTML = `<i class="status-dot ${data.enabled ? 'on' : ''}"></i>${data.enabled ? 'Edge 代理已启用' : '代理已关闭'}`;
  page.innerHTML = ({home:renderHome,proxies:renderProxies,subscriptions:renderSubscriptions,connections:renderConnections,rules:renderRules,logs:renderLogs,tests:renderTests,settings:renderSettings}[route])();
  page.dataset.route = route;
}

async function load(silent = false) {
  const current = ++loadToken;
  if (!silent) page.innerHTML = '<div class="loading">正在读取扩展状态…</div>';
  try {
    const fresh = await send('snapshot', { page: route });
    if (current !== loadToken) return;
    data = fresh;
    render();
  } catch (error) {
    if (!data) page.innerHTML = `<section class="panel">${empty('请在 Edge 中加载插件', e(error.message), 'info')}<p class="hint">打开 edge://extensions，启用开发人员模式，选择「加载解压缩的扩展」，并选中 extension 文件夹。</p></section>`;
    else toast(error.message, true);
  }
}

function navigate() {
  route = location.hash.replace('#', '') || 'home';
  if (!pages.some(p => p[0] === route)) route = 'home';
  const current = pages.find(p => p[0] === route);
  document.getElementById('page-title').textContent = current[1];
  document.getElementById('page-description').textContent = current[3];
  document.getElementById('navigation').innerHTML = pages.map(([id,name,ico]) => `<a href="#${id}" class="nav-item ${id === route ? 'active' : ''}" ${id === route ? 'aria-current="page"' : ''} title="${name}" aria-label="${name}">${icon(ico)}<span>${name}</span></a>`).join('');
  load();
}

async function execute(command, payload = {}, success = '') {
  if (busy) return;
  busy = true;
  page.setAttribute('aria-busy', 'true');
  const buttons = [...page.querySelectorAll('button')];
  buttons.forEach(b => b.disabled = true);
  try {
    const answer = await send(command, payload);
    if (success) toast(success);
    await load(true);
    return answer;
  } catch (error) { toast(error.message, true); await load(true); }
  finally { busy = false; page.removeAttribute('aria-busy'); buttons.forEach(b => b.disabled = false); }
}

async function testMany(names) {
  if (busy) return;
  busy = true;
  const targets = [...new Set(names)].filter(n => !['DIRECT','REJECT','REJECT-DROP','COMPATIBLE','PASS'].includes(n));
  if (targets.length > 100) { busy = false; toast('请按策略组测试；每次最多测试 100 个节点。', true); return; }
  try {
    for (let i = 0; i < targets.length; i++) {
      toast(`正在测试 ${i + 1} / ${targets.length}：${targets[i]}`);
      await send('testProxy', { name: targets[i] });
    }
    toast(targets.length ? `已完成 ${targets.length} 个节点的测试` : '此处没有可测试的节点');
    await load(true);
  } catch (error) { toast(error.message, true); }
  finally { busy = false; }
}

page.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || busy) return;
  const a = target.dataset.action;
  switch (a) {
    case 'toggle': return execute('toggleProxy', { enabled: !data.enabled }, data.enabled ? '已释放 Edge 代理' : 'Edge 代理已启用');
    case 'geo': return execute('detectGeo', {}, '出口检测完成');
    case 'start': return execute('start', {}, '独立内核已启动');
    case 'stop': return execute('stop', {}, '内核已停止，Edge 代理已释放');
    case 'activate': return execute('activateSubscription', { id: target.dataset.id }, '配置已应用，Edge 代理已启用');
    case 'updateSub': return execute('updateSubscription', { id: target.dataset.id }, '订阅已更新');
    case 'deleteSub': return execute('deleteSubscription', { id: target.dataset.id }, '订阅已删除');
    case 'select': return execute('selectProxy', { group: target.dataset.group, name: target.dataset.name }, '节点已切换');
    case 'mode': return execute('mode', { mode: target.dataset.mode, page: route }, '代理模式已更新');
    case 'testNode': return execute('testProxy', { name: target.dataset.name }, '测试完成');
    case 'testGroup': return testMany(data.proxies?.[target.dataset.group]?.all || []);
    case 'testAll': return testMany(Object.entries(data.proxies || {}).filter(([,x]) => !Array.isArray(x.all)).map(([n]) => n));
    case 'closeConnection': return execute('closeConnection', { id: target.dataset.id }, '连接已关闭');
    case 'closeAll': return execute('closeAllConnections', {}, '已关闭内核中的全部连接');
    case 'deleteRule': return execute('deleteRule', { id: target.dataset.id }, '规则已删除');
    case 'clearLogs': return execute('clearLogs', {}, '插件操作记录已清空');
    case 'exportLogs': return downloadJson('EdgeLink-logs.json', logs());
    case 'diagnostics': return downloadJson('EdgeLink-diagnostics.json', { version: chrome.runtime.getManifest().version, capturedAt: new Date().toISOString(), core: data.core, enabled: data.enabled, mode: data.mode, levelOfControl: data.levelOfControl, subscriptionCount: data.subscriptions.length, tests: data.tests.map(x => ({ok:x.ok,delay:x.delay})), geo: data.geo, logs: data.logs.filter(x => x.level !== 'info').map(x => ({time:x.time,level:x.level,message:x.message})) });
    case 'pasteSubmit': return document.getElementById('paste-form').requestSubmit();
  }
});

page.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const fields = Object.fromEntries(new FormData(event.target));
  switch (event.target.id) {
    case 'subscription-form': return execute('importSubscription', fields, '订阅已导入，点击「使用此配置」继续');
    case 'paste-form': return execute('importSubscription', { ...fields, name: fields.name || '本地配置' }, '配置已导入');
    case 'rule-form': return execute('addRule', fields, '浏览器分流规则已添加');
    case 'settings-form': return execute('settings', { ...fields, autoDetect: fields.autoDetect === 'on' }, '设置已保存');
  }
});

page.addEventListener('input', event => {
  if (event.target.id !== 'proxy-search') return;
  const position = event.target.selectionStart;
  proxyFilter = event.target.value;
  render();
  const input = document.getElementById('proxy-search');
  input.focus(); input.setSelectionRange(position, position);
});
page.addEventListener('change', event => { if (event.target.id === 'log-filter') { logFilter = event.target.value; render(); } });
document.getElementById('refresh-page').addEventListener('click', () => {
  if (busy) return;
  if (['home','connections','tests'].includes(route) && data?.enabled) return execute('detectGeo', {}, '出口地区已刷新');
  load();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state && data && !busy && !document.hidden && ['home','connections','tests'].includes(route)) load(true);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && data && !busy && ['home','connections','tests'].includes(route)) load(true);
});
window.addEventListener('hashchange', navigate);
setInterval(() => { if (!document.hidden && !busy && route === 'connections' && !page.contains(document.activeElement)) load(true); }, 3000);
navigate();
