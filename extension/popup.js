import { send } from './core/client.js';
import { icon, escape as e, toast } from './ui.js';
let data;
const target = document.getElementById('popup');
document.getElementById('open-settings').innerHTML = icon('settings');
function open(hash = '') { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') + hash }); window.close(); }
document.getElementById('open-dashboard').addEventListener('click', () => open());
document.getElementById('open-settings').addEventListener('click', () => open('#settings'));
async function refresh() {
  try {
    data = await send('snapshot');
    const active = data.subscriptions.find(x => x.active);
    target.innerHTML = `<div class="popup-status"><div><span class="badge ${data.enabled ? 'green' : ''}"><i class="status-dot ${data.enabled ? 'on' : ''}"></i>${data.core.running ? '内核运行中' : '内核未启动'}</span><h1>${data.enabled ? '代理已启用' : '代理已关闭'}</h1></div><button class="power-button ${data.enabled ? 'on' : ''}" id="popup-toggle" aria-label="${data.enabled ? '关闭代理' : '启用代理'}">${icon('power')}</button></div><div class="segmented" aria-label="代理模式">${[['rule','规则'],['global','全局'],['direct','直连']].map(([v,l])=>`<button data-mode="${v}" class="${data.mode===v?'selected':''}">${l}</button>`).join('')}</div><div class="data-row"><span>当前配置</span><span>${e(active?.name || '尚未导入')}</span></div><div class="data-row"><span>出口地区</span><span>${e(data.geo?.country || '等待检测')}</span></div><div class="data-row"><span>公网 IP</span><span>${e(data.geo?.ip || '—')}</span></div>`;
  } catch(error) { target.innerHTML = `<p class="popup-error">${e(error.message)}</p>`; }
}
target.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.id === 'popup-toggle') await send('toggleProxy', { enabled: !data.enabled });
    if (button.dataset.mode) await send('mode', { mode: button.dataset.mode });
    await refresh();
  } catch(error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
refresh();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.state) refresh(); });
