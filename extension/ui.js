export const paths = {
  home: '<path d="m3 10 9-7 9 7M5 9v11h14V9M9 20v-7h6v7"/>',
  proxy: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  subscription: '<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="18" height="7" rx="1"/><path d="M6 6.5h2M6 17.5h2M12 6.5h6M12 17.5h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
  rules: '<path d="M5 21V3M5 5h13l-3 4 3 4H5M12 17l3 3 5-5"/>',
  logs: '<path d="M4 5h16M4 10h16M4 15h12M4 20h8"/>',
  test: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  settings: '<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  power: '<path d="M12 3v9M6.3 5.7a9 9 0 1 0 11.4 0"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  external: '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  upload: '<path d="M12 17V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  logo: '<circle cx="12" cy="12" r="9"/><path d="m7 17 10-10"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="7" r="2"/>'
};
export function icon(name, className = '') { return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`; }
export function escape(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function bytes(value = 0) { const n = Number(value) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; }
export function time(value) { if (!value) return '尚未检测'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false }); }
export function toast(message, error = false) { const host = document.getElementById('toast'); host.textContent = message; host.className = 'toast visible' + (error ? ' error' : ''); clearTimeout(host.timer); host.timer = setTimeout(() => host.className = 'toast', error ? 8000 : 3500); }
