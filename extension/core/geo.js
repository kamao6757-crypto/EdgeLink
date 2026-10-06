export const GEO_SERVICES = [
  { id: 'ipwho', url: 'https://ipwho.is/' },
  { id: 'ipsb', url: 'https://api.ip.sb/geoip' }
];

export function geoConnectionIds(connections = []) {
  if (!Array.isArray(connections)) return [];
  const hosts = new Set(GEO_SERVICES.map(service => new URL(service.url).hostname));
  return [...new Set(connections.filter(connection => typeof connection.id === 'string' && connection.id &&
    [connection.metadata?.host, connection.metadata?.sniffHost].some(value =>
      typeof value === 'string' && hosts.has(value.toLowerCase().replace(/\.$/, ''))))
    .map(connection => connection.id))];
}

export function normalizeGeo(id, data) {
  if (!data || typeof data !== 'object' || data.success === false || data.error) throw new Error('地区服务未返回有效结果');
  const ip = String(data.ip || '');
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) throw new Error('地区服务没有返回 IP');
  const country = String(data.country || data.country_name || '');
  if (!country) throw new Error('地区服务没有返回国家或地区');
  return {
    ip, country, countryCode: String(data.country_code || ''),
    region: String(data.region || ''), city: String(data.city || ''),
    isp: String(data.connection?.isp || data.isp || data.organization || ''),
    timezone: String(data.timezone?.id || (typeof data.timezone === 'string' ? data.timezone : '')),
    source: id, checkedAt: new Date().toISOString()
  };
}

export async function detectGeo(fetcher = fetch, timeoutMs = 10000) {
  for (const service of GEO_SERVICES) {
    try {
      const started = performance.now();
      const response = await fetcher(service.url + '?_=' + Date.now(), { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return { ...normalizeGeo(service.id, await response.json()), latency: Math.round(performance.now() - started) };
    } catch { /* Try the independent second location service. */ }
  }
  throw new Error('出口检测失败：请检查当前节点，稍后重试。');
}
