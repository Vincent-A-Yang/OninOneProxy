/**
 * @file modelForwarding.js
 * @description 模型淘汰重定向模块（Task 11）
 *
 * 当 provider 已淘汰某模型时，根据 MODEL_FORWARDING_RULES 环境变量
 * 自动重定向到替代模型，客户端无感知（响应中的 model 字段保持原模型名）。
 *
 * 配置格式（环境变量 MODEL_FORWARDING_RULES，JSON 字符串）：
 *   {
 *     "openai": { "gpt-3.5-turbo": "gpt-4o-mini" },
 *     "anthropic": { "claude-1": "claude-3-5-haiku-20241022" }
 *   }
 *
 * 设计要点：
 * - Fail-open 契约：任何异常（配置缺失、JSON 解析失败、查询异常）都吞掉，
 *   返回原模型名，绝不阻塞请求
 * - 配置缓存在模块级变量，首次访问时解析；支持运行时通过刷新机制更新
 * - 大小写不敏感：provider 和 model 均小写匹配
 * - 纯函数，无副作用，不修改入参
 *
 * Public API:
 *   - getForwardingModel(provider, model) — 查询替代模型
 *   - reloadForwardingRules()              — 强制重新加载配置（测试/热更新用）
 */

/** 日志前缀 */
const LOG_PREFIX = "[ModelForwarding]";

/**
 * 缓存的转发规则（解析后的 JSON 对象）。
 * null = 尚未加载；undefined = 加载失败或无配置；Object = 已加载。
 * @type {Object|null|undefined}
 */
let _cachedRules = null;

/**
 * 加载并解析 MODEL_FORWARDING_RULES 环境变量。
 *
 * Fail-open：任何异常都返回空对象（无转发规则），绝不抛出。
 *
 * @returns {Object} 解析后的转发规则对象，格式：{ provider: { oldModel: newModel } }
 */
function loadRules() {
  try {
    const raw = process.env.MODEL_FORWARDING_RULES;
    if (!raw || typeof raw !== "string" || raw.trim() === "") {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // 规范化：provider 和 model 键名小写，值保持原样
    const normalized = {};
    for (const provider of Object.keys(parsed)) {
      const rules = parsed[provider];
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) continue;
      const providerLower = String(provider).toLowerCase();
      normalized[providerLower] = {};
      for (const oldModel of Object.keys(rules)) {
        const newModel = rules[oldModel];
        if (typeof newModel !== "string" || newModel.trim() === "") continue;
        normalized[providerLower][String(oldModel).toLowerCase()] = newModel;
      }
    }
    return normalized;
  } catch (err) {
    // JSON 解析失败或其他异常 → fail-open，返回空规则
    try {
      console.warn(`${LOG_PREFIX} 配置解析失败，fail-open 返回空规则: ${err?.message || err}`);
    } catch { /* 连 console.warn 都失败，静默 */ }
    return {};
  }
}

/**
 * 获取缓存的转发规则，首次调用时懒加载。
 *
 * @returns {Object} 转发规则对象
 */
function getRules() {
  if (_cachedRules === null) {
    _cachedRules = loadRules();
  }
  return _cachedRules || {};
}

/**
 * 强制重新加载转发规则配置。
 *
 * 用于测试或运行时热更新场景。下次调用 getForwardingModel 时会重新读取环境变量。
 */
export function reloadForwardingRules() {
  _cachedRules = null;
}

/**
 * 查询模型的替代模型（若已配置转发规则）。
 *
 * 当 provider 已淘汰某模型时，根据 MODEL_FORWARDING_RULES 自动返回替代模型名。
 * 客户端无感知：调用方应保持响应中的 model 字段为原模型名。
 *
 * Fail-open 契约：
 * - 配置缺失 → 返回原模型
 * - JSON 解析失败 → 返回原模型
 * - provider/model 未配置转发 → 返回原模型
 * - 任何内部异常 → 返回原模型
 *
 * @param {string} provider - Provider 名称（如 "openai"、"anthropic"）
 * @param {string} model - 原始模型名称（如 "gpt-3.5-turbo"）
 * @returns {string} 替代模型名（若配置了转发规则），否则返回原模型名
 */
export function getForwardingModel(provider, model) {
  try {
    if (!provider || !model) return model;
    const rules = getRules();
    if (!rules || Object.keys(rules).length === 0) return model;

    const providerLower = String(provider).toLowerCase();
    const modelLower = String(model).toLowerCase();

    const providerRules = rules[providerLower];
    if (!providerRules) return model;

    const forwarded = providerRules[modelLower];
    if (typeof forwarded === "string" && forwarded.trim() !== "") {
      return forwarded;
    }
    return model;
  } catch (err) {
    // Fail-open：任何异常返回原模型
    try {
      console.warn(`${LOG_PREFIX} getForwardingModel 异常，fail-open 返回原模型: ${err?.message || err}`);
    } catch { /* 静默 */ }
    return model;
  }
}

export default { getForwardingModel, reloadForwardingRules };
