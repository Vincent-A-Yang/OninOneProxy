/**
 * @file authReverify.js
 * @description 401 即时重验证模块（fire-and-forget）
 *
 * 来自 freellmapi 的吸取功能点：当上游返回 401 时，触发即时重验证，
 * 标记账号状态以便故障转移池快速剔除失效账号。30s 去重窗口避免重复触发。
 *
 * 设计要点：
 * - triggerReverify 同步返回（fire-and-forget），不阻塞调用方故障转移
 * - 30s 去重窗口，同一 connectionId 30s 内只触发一次
 * - 使用 globalThis 挂载 state，避免 HMR 重复实例化导致计数丢失
 * - performReverify 内部动态 import auth.js，避免顶层循环依赖
 * - 所有操作 try/catch，fail-open，绝不阻塞调用方
 *
 * 注意：OAuth token refresh 本身由 chatCore 的 401/403 处理流程负责
 * （需要 executor + credentials）。本模块的职责是标记账号池状态，
 * 使故障转移能快速剔除失效账号。markAccountUnavailable 实际签名第二参数
 * 为 HTTP status（数字），语义原因放入 errorText。
 */

// --- globalThis state（HMR 安全，避免热更新重复实例）---
const _g = globalThis;
if (!_g.__authReverifyState) {
  _g.__authReverifyState = {
    /** @type {Map<string, {triggeredAt: number, promise: Promise<void>}>} */
    reverifyMap: new Map(),
    totalTriggered: 0,
    totalSkipped: 0,
  };
}

const __state = _g.__authReverifyState;
const reverifyMap = __state.reverifyMap;

/** 30 秒去重窗口 */
const REVERIFY_DEDUP_MS = 30 * 1000;

/** 日志前缀 */
const LOG_PREFIX = "[AuthReverify]";

/**
 * 实际执行重验证（内部函数，不导出）。
 *
 * 动态 import auth.js 的 markAccountUnavailable，将账号标记为不可用，
 * 以便故障转移池快速剔除。OAuth token refresh 由 chatCore 流程负责
 * （需 executor + credentials，本模块无法获取），此处聚焦账号池状态标记。
 *
 * @param {string} connectionId - 连接 ID
 * @param {string} provider - provider id
 * @returns {Promise<{success: boolean, reason: string}>}
 */
async function performReverify(connectionId, provider) {
  try {
    // 动态 import 避免顶层循环依赖；@ 别名指向 src/（webpack 运行时解析）
    const authModule = await import("@/sse/services/auth.js");
    const markAccountUnavailable = authModule.markAccountUnavailable;
    if (typeof markAccountUnavailable !== "function") {
      console.warn(`${LOG_PREFIX} markAccountUnavailable not found in auth.js`);
      return { success: false, reason: "function_missing" };
    }

    // 真实签名: markAccountUnavailable(connectionId, status, errorText, provider, model, resetsAtMs)
    // status 为 HTTP 状态码（数字），语义原因放入 errorText
    const errorText = `401 unauthorized (reverify, provider=${provider || "unknown"})`;
    const result = await markAccountUnavailable(
      connectionId,
      401,
      errorText,
      provider,
      null,
      null
    );

    const reason = result?.shouldFallback ? "marked_unavailable" : "no_lock_needed";
    console.log(`${LOG_PREFIX} Reverify completed for ${connectionId}: ${reason}`);
    return { success: true, reason };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Reverify failed for ${connectionId}: ${err?.message || err}`);
    return { success: false, reason: "exception", error: err?.message || String(err) };
  }
}

/**
 * fire-and-forget 触发重验证。同步返回，不阻塞调用方。
 *
 * 调用方在收到 401 后立即调用本函数，然后继续故障转移流程；
 * 重验证在后台异步执行，30s 内同一 connectionId 只触发一次。
 *
 * @param {string} connectionId - 连接 ID
 * @param {string} provider - provider id
 * @param {{onError?: (err: Error) => void}} [options] - 可选错误回调
 * @returns {boolean} true=已触发，false=跳过（30s 内重复或参数无效）
 */
function triggerReverify(connectionId, provider, options = {}) {
  if (!connectionId) {
    console.warn(`${LOG_PREFIX} triggerReverify called without connectionId`);
    return false;
  }

  // 1. 去重检查：30s 内已有未过期条目则跳过
  const existing = reverifyMap.get(connectionId);
  if (existing && Date.now() - existing.triggeredAt < REVERIFY_DEDUP_MS) {
    __state.totalSkipped++;
    console.log(`${LOG_PREFIX} Skipping duplicate reverify for ${connectionId}`);
    return false;
  }

  // 2. 创建条目并立即同步存入 map（保证并发去重）
  /** @type {{triggeredAt: number, promise: Promise<void>}} */
  const entry = { triggeredAt: Date.now(), promise: null };
  reverifyMap.set(connectionId, entry);
  __state.totalTriggered++;

  // 3. fire-and-forget：异步执行，不 await，调用方立即继续故障转移
  const promise = performReverify(connectionId, provider)
    .catch((err) => {
      // performReverify 内部已 try/catch，此处为兜底防护
      console.warn(
        `${LOG_PREFIX} Reverify promise rejected for ${connectionId}: ${err?.message || err}`
      );
      try {
        if (typeof options.onError === "function") options.onError(err);
      } catch {
        /* onError 失败不影响主流程 */
      }
    })
    .finally(() => {
      // 30s 去重窗口从 triggeredAt 起算；窗口结束后清除条目
      const elapsed = Date.now() - entry.triggeredAt;
      const remaining = Math.max(0, REVERIFY_DEDUP_MS - elapsed);
      setTimeout(() => {
        const cur = reverifyMap.get(connectionId);
        // 仅删除自身条目，避免误删 newer 条目
        if (cur === entry) reverifyMap.delete(connectionId);
      }, remaining);
    });

  entry.promise = promise;
  return true;
}

/**
 * 检查某 connectionId 是否正在重验证中（30s 窗口内）。
 *
 * @param {string} connectionId - 连接 ID
 * @returns {boolean} true=正在重验证中，false=无条目或已过期
 */
function isReverifyInProgress(connectionId) {
  if (!connectionId) return false;
  const entry = reverifyMap.get(connectionId);
  if (!entry) return false;
  // 超过 30s 视为过期（兜底，正常情况 finally 定时器已清除）
  return Date.now() - entry.triggeredAt < REVERIFY_DEDUP_MS;
}

/**
 * 手动清除某 connectionId 的重验证状态。
 * 用于账号恢复后立即允许下次 401 重新触发重验证。
 *
 * @param {string} connectionId - 连接 ID
 * @returns {boolean} true=已清除，false=本无条目或参数无效
 */
function clearReverifyState(connectionId) {
  if (!connectionId) return false;
  return reverifyMap.delete(connectionId);
}

/**
 * 返回重验证统计信息。
 *
 * @returns {{inProgress: number, totalTriggered: number, totalSkipped: number}}
 */
function getReverifyStats() {
  // inProgress 统计未过期条目（过期残留条目不计入）
  let inProgress = 0;
  const now = Date.now();
  for (const entry of reverifyMap.values()) {
    if (now - entry.triggeredAt < REVERIFY_DEDUP_MS) inProgress++;
  }
  return {
    inProgress,
    totalTriggered: __state.totalTriggered,
    totalSkipped: __state.totalSkipped,
  };
}

export {
  triggerReverify,
  isReverifyInProgress,
  clearReverifyState,
  getReverifyStats,
};
