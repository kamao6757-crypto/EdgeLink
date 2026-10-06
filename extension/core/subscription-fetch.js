import { validateSubscriptionUrl } from './subscriptions.js';

export const SUBSCRIPTION_REQUEST_RULE_ID = 1001;
const MAX_BYTES = 4 * 1024 * 1024;

export function subscriptionRequestRule(rawUrl, extensionId) {
  const url = validateSubscriptionUrl(rawUrl);
  return {
    id: SUBSCRIPTION_REQUEST_RULE_ID, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'user-agent', operation: 'set', value: 'clash.meta' }] },
    condition: {
      urlFilter: '|' + new URL(url).origin + '/',
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [extensionId], resourceTypes: ['xmlhttprequest'], requestMethods: ['get']
    }
  };
}

export async function downloadSubscription(rawUrl, {
  fetcher = fetch,
  rules = globalThis.chrome?.declarativeNetRequest,
  extensionId = globalThis.chrome?.runtime?.id
} = {}) {
  const url = validateSubscriptionUrl(rawUrl);
  if (!rules || !extensionId) throw new Error('请重新加载最新版本扩展，以启用订阅兼容请求。');
  try {
    await rules.updateSessionRules({ removeRuleIds: [SUBSCRIPTION_REQUEST_RULE_ID], addRules: [subscriptionRequestRule(url, extensionId)] });
  } catch {
    throw new Error('无法启用订阅兼容请求，请在扩展管理中重新加载最新版本。');
  }
  try {
    const response = await fetcher(url, {
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: { Accept: '*/*' }
    });
    if (!response.ok) {
      const detail = response.status === 400 ? '服务拒绝此订阅请求，请确认链接仍有效。'
        : [401,403].includes(response.status) ? '订阅访问被拒绝，请检查有效期与访问令牌。'
        : '请检查链接或稍后重试。';
      throw new Error('订阅下载失败（HTTP ' + response.status + '），' + detail);
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('订阅内容超过 4 MiB。');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('订阅服务返回了空内容。');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('订阅内容超过 4 MiB。'); }
      chunks.push(value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const part of chunks) { merged.set(part, offset); offset += part.length; }
    const usage = {};
    for (const [key, value] of (response.headers.get('subscription-userinfo') || '').split(';').map(x => x.trim().split('='))) {
      if (['upload','download','total','expire'].includes(key) && value && Number.isFinite(Number(value))) usage[key] = Number(value);
    }
    return { text: new TextDecoder().decode(merged), usage };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('订阅下载超时，请检查网络后重试。');
    if (error instanceof TypeError) throw new Error('订阅网络请求失败，请检查网络与服务证书后重试。');
    throw error;
  } finally {
    await rules.updateSessionRules({ removeRuleIds: [SUBSCRIPTION_REQUEST_RULE_ID] }).catch(() => {});
  }
}

export function subscriptionSource(rawUrl) {
  const url = new URL(rawUrl);
  const safePath = url.pathname.replace(/\/[^/]+/g, segment => segment.length > 17 ? '/••••' : segment);
  return url.origin + safePath + (url.search ? '?••••' : '');
}
