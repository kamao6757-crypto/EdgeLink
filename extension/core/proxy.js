export const LOCAL_PROXY_PORT = 17890;

export function buildProxyConfig(mode = 'rule', rules = []) {
  if (!['rule', 'global', 'direct'].includes(mode)) throw new Error('无效代理模式');
  if (mode === 'direct') return { mode: 'direct' };
  const proxy = 'PROXY 127.0.0.1:' + LOCAL_PROXY_PORT;
  const conditions = rules.map((rule) => {
    if (!['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(rule.type)) throw new Error('不支持的浏览器规则类型');
    const value = String(rule.value || '').trim().toLowerCase();
    if (!value || value.length > 253 || /[\s;"'\\/]/.test(value)) throw new Error('规则需要有效的域名或关键词');
    if (!['DIRECT', 'PROXY'].includes(rule.action)) throw new Error('无效规则动作');
    const literal = JSON.stringify(value);
    const match = rule.type === 'DOMAIN' ? 'host === ' + literal
      : rule.type === 'DOMAIN-SUFFIX' ? '(host === ' + literal + ' || dnsDomainIs(host, ' + JSON.stringify('.' + value) + '))'
      : 'host.indexOf(' + literal + ') !== -1';
    return 'if (' + match + ') return ' + JSON.stringify(rule.action === 'DIRECT' ? 'DIRECT' : proxy) + ';';
  }).join('\n');
  return {
    mode: 'pac_script',
    pacScript: {
      mandatory: true,
      data: `function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]' || shExpMatch(host, '127.*')) return 'DIRECT';
  ${mode === 'rule' ? conditions : ''}
  return '${proxy}';
}`
    }
  };
}

export function proxyFingerprint(value) {
  return JSON.stringify(value || {});
}
