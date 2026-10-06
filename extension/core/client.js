export async function send(command, payload = {}) {
  if (!globalThis.chrome?.runtime?.id) throw new Error('请在 Edge 的扩展页面中加载此插件后使用。');
  const response = await chrome.runtime.sendMessage({ command, payload });
  if (!response?.ok) throw new Error(response?.error || '扩展后台没有响应，请重新加载插件。');
  return response.data;
}

export function downloadJson(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
