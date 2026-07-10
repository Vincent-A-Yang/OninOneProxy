import { getProxyPoolById } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Domestic (China mainland) provider hosts that should bypass Clash proxy.
 * These upstreams are directly reachable from the container without a proxy;
 * routing them through Clash caused HTTP 400 / 30s timeouts (see
 * docs/network-performance-audit.md §5.1).
 *
 * Matching is suffix-based: "deepseek.com" matches "api.deepseek.com".
 */
const DOMESTIC_DIRECT_HOSTS = [
  "deepseek.com",          // DeepSeek (api.deepseek.com)
  "moonshot.cn",           // Kimi (api.moonshot.cn)
  "aliyuncs.com",          // Qwen / DashScope (dashscope.aliyuncs.com)
  "bigmodel.cn",           // GLM / Zhipu (open.bigmodel.cn)
  "baichuan-ai.com",       // Baichuan (api.baichuan-ai.com)
  "xf-yun.com",            // iFlytek Spark (spark-api.xf-yun.com)
  "volcengine.com",        // Volcano / Doubao (ark.cn-beijing.volces.com)
  "minimaxi.com",          // MiniMax (api.minimaxi.com)
  "stepfun.com",           // Stepfun (api.stepfun.com)
  "01.ai",                 // Yi / Lingyi (api.01.ai)
  "hunyuan.tencent.com",   // Tencent Hunyuan
  "baidubce.com",          // Baidu / ERNIE (qianfan.baidubce.com)
];

/**
 * Check if a target URL points to a domestic provider that should bypass proxy.
 * @param {string} targetUrl - The URL being fetched
 * @returns {boolean} true if the host matches a domestic direct-connect entry
 */
export function isDomesticDirectHost(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return DOMESTIC_DIRECT_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
