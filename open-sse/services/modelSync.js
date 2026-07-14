/**
 * ModelSyncService — 定时同步所有 active provider 的模型列表、参数与价格
 *
 * 设计参考（OmniRoute 同步机制）[推断]：
 *   据公开资料与 9Router 衍生关系推断，OmniRoute 采用以下同步模式：
 *     1. 周期性后台轮询 provider 的 /models 端点（或 modelsFetcher.url）
 *     2. 内存缓存 + 持久化存储（DB kv）双层缓存
 *     3. 失败回退到静态 registry（fail-open）
 *     4. 价格与参数分离存储，便于独立更新
 *     5. 并发拉取 + 限流（避免瞬时打满 provider）
 *   本实现遵循相同原则，但具体协议细节为基于项目结构的设计推断，
 *   未直接对照 OmniRoute 源码 — 标注 [推断] (P-0#9 防幻觉)。
 *
 * Fail-open 契约：
 *   - 单个 provider 同步失败不影响其他 provider
 *   - syncAll 永不抛出，错误汇聚到 results[].error
 *   - DB 写入失败返回 { updated: 0, error } 而非抛出
 *   - 定时器调度失败仅打印 warn，不阻塞主服务
 *
 * 数据流：
 *   REGISTRY (read-only) → fetchProviderModels → updateModelParams (DB kv)
 *                                                → updateModelPricing (DB pricing kv)
 *   pricing.js (read-only) 作为 fallback，不被修改 (P-0#9 不破坏现有结构)
 *
 * 并发策略：
 *   Promise.all + 分块（chunk size = 5），避免瞬时打满 provider。
 *
 * Public API:
 *   - modelSyncService.fetchProviderModels(providerId)
 *   - modelSyncService.updateModelParams(providerId, models)
 *   - modelSyncService.updateModelPricing(providerId, pricing)
 *   - modelSyncService.syncAll(options?)
 *   - modelSyncService.startSyncScheduler(intervalMs?)
 *   - modelSyncService.stopSyncScheduler()
 *   - modelSyncService.getSyncStatus()
 */

import REGISTRY from "../providers/registry/index.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../providers/index.js";
// Use relative paths (not "@/lib/...") because this module is loaded via
// dynamic import() from custom-server.js (CJS standalone build), which runs
// under Node's native ESM resolver — it does not understand jsconfig paths
// like "@/lib/...". Other open-sse files that use "@/lib/..." work because
// they are imported through Next.js API routes (webpack resolves the alias).
//
// Direct repo import (not barrel `db/index.js`) because the barrel re-exports
// connectionsRepo.js which depends on `@/shared/constants/providers` — a
// webpack alias unavailable under Node native ESM. Importing pricingRepo
// directly only pulls in driver.js → paths.js → dataDir.js (all relative).
import { updatePricing } from "../../src/lib/db/repos/pricingRepo.js";
import { makeKv } from "../../src/lib/db/helpers/kvStore.js";

// 模型参数持久化 kv（scope: 'modelParams'，key: providerId）
const modelParamsKv = makeKv("modelParams");

// 默认并发限流：5 个 provider 同时拉取
const DEFAULT_CONCURRENCY = 5;

// 默认同步周期：6 小时（与 OmniRoute 推断的周期一致）
const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// HTTP 拉取超时：15 秒
const FETCH_TIMEOUT_MS = 15 * 1000;

// 首次同步延迟：30 秒（避开启动峰值）
const FIRST_SYNC_DELAY_MS = 30 * 1000;

const TAG = "MODEL-SYNC";

/**
 * 从 registry entry 提取 modelsFetcher 配置。
 * 优先从 PROVIDER_MEDIA（已合并 entry 顶层字段与 entry.media）取，回退到 entry 自身。
 */
function getModelsFetcher(entry) {
  const media = PROVIDER_MEDIA[entry.id];
  if (media?.modelsFetcher) return media.modelsFetcher;
  if (entry.modelsFetcher) return entry.modelsFetcher;
  return null;
}

/**
 * 从 OpenAI 兼容的 /models 响应中提取模型列表。
 * 兼容 { data: [{ id }] } 与 { models: [{ id }] } 两种形态。
 */
function parseModelsResponse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.models)) return json.models;
  return [];
}

/**
 * 规范化单个模型条目：保证至少有 id 字段，补充 name。
 */
function normalizeFetchedModel(raw) {
  if (typeof raw === "string") return { id: raw };
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id) return null;
  return { id: raw.id, name: raw.name || raw.id, ...raw };
}

/**
 * 带超时的 fetch，避免 hang 死。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 registry 静态模型列表读取（fallback 路径，不打外部网络）。
 */
function readStaticModels(entry) {
  const alias = entry.alias || entry.id;
  const fromProviderModels = PROVIDER_MODELS[alias] || [];
  if (fromProviderModels.length) return fromProviderModels;
  if (Array.isArray(entry.models)) return entry.models.map((m) => (typeof m === "string" ? { id: m } : m));
  return [];
}

/**
 * 真正执行 HTTP 拉取（独立函数便于 fail-open 包裹）。
 */
async function doFetchModels(fetcher) {
  const resp = await fetchWithTimeout(fetcher.url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  const list = parseModelsResponse(json);
  return list.map(normalizeFetchedModel).filter(Boolean);
}

/**
 * 将数组按 size 切块，用于并发限流。
 */
function chunk(list, size) {
  if (size <= 0) return [list];
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

/**
 * ModelSyncService — 单例服务类
 */
export class ModelSyncService {
  constructor() {
    this._lastSync = null;
    this._syncing = false;
    this._intervalHandle = null;
    this._firstRunHandle = null;
  }

  /**
   * 拉取单个 provider 的模型列表。
   *
   * 优先使用 registry 中声明的 modelsFetcher.url 进行 HTTP 拉取；
   * 若无 fetcher 或拉取失败，回退到 registry 静态 models 列表（fail-open）。
   *
   * @param {string} providerId - provider id（与 registry entry.id 对应）
   * @returns {Promise<{providerId: string, models: Array, source: string, fetchedAt: string, error?: string}>}
   */
  async fetchProviderModels(providerId) {
    const fetchedAt = new Date().toISOString();
    const entry = REGISTRY.find((e) => e.id === providerId);
    if (!entry) {
      return { providerId, models: [], source: "unknown", fetchedAt, error: "provider not in registry" };
    }
    const fetcher = getModelsFetcher(entry);
    if (!fetcher) {
      // 无 fetcher：直接返回静态列表
      return { providerId, models: readStaticModels(entry), source: "static", fetchedAt };
    }
    try {
      const models = await doFetchModels(fetcher);
      return { providerId, models, source: "fetcher", fetchedAt };
    } catch (e) {
      // Fail-open：HTTP 失败时回退到静态列表
      const staticModels = readStaticModels(entry);
      console.warn(`[${TAG}] fetch ${providerId} failed, fallback to static (${staticModels.length}): ${e?.message || e}`);
      return {
        providerId,
        models: staticModels,
        source: "fallback",
        fetchedAt,
        error: e?.message || String(e),
      };
    }
  }

  /**
   * 更新单个 provider 的模型参数（context_window、max_tokens、supports_streaming）。
   *
   * 写入 DB kv（scope='modelParams', key=providerId）。
   * 不修改 registry，不修改 pricing.js。
   *
   * @param {string} providerId
   * @param {Array<{id: string, context_window?: number, max_tokens?: number, supports_streaming?: boolean}>} models
   * @returns {Promise<{providerId: string, updated: number, error?: string}>}
   */
  async updateModelParams(providerId, models) {
    if (!providerId) return { providerId: "", updated: 0, error: "providerId required" };
    if (!Array.isArray(models)) return { providerId, updated: 0, error: "models must be array" };
    try {
      const params = {};
      for (const m of models) {
        if (!m?.id) continue;
        params[m.id] = {
          context_window: m.context_window ?? m.contextWindow ?? null,
          max_tokens: m.max_tokens ?? m.maxTokens ?? null,
          supports_streaming: m.supports_streaming ?? m.supportsStreaming ?? null,
        };
      }
      await modelParamsKv.set(providerId, params);
      return { providerId, updated: Object.keys(params).length };
    } catch (e) {
      console.warn(`[${TAG}] updateModelParams ${providerId} failed: ${e?.message || e}`);
      return { providerId, updated: 0, error: e?.message || String(e) };
    }
  }

  /**
   * 更新单个 provider 的模型价格（input_price、output_price 等）。
   *
   * 通过 pricingRepo.updatePricing 写入 DB kv（scope='pricing'）。
   * 不修改 pricing.js 文件本身 — 运行时由 pricingRepo.getPricing 合并读取。
   *
   * @param {string} providerId
   * @param {Object<string, {input: number, output: number, cached?: number, reasoning?: number, cache_creation?: number}>} pricing
   * @returns {Promise<{providerId: string, updated: number, error?: string}>}
   */
  async updateModelPricing(providerId, pricing) {
    if (!providerId) return { providerId: "", updated: 0, error: "providerId required" };
    if (!pricing || typeof pricing !== "object") {
      return { providerId, updated: 0, error: "pricing must be object" };
    }
    try {
      await updatePricing({ [providerId]: pricing });
      return { providerId, updated: Object.keys(pricing).length };
    } catch (e) {
      console.warn(`[${TAG}] updateModelPricing ${providerId} failed: ${e?.message || e}`);
      return { providerId, updated: 0, error: e?.message || String(e) };
    }
  }

  /**
   * 同步所有 active provider。
   *
   * 流程：
   *   1. 从 REGISTRY 枚举所有 provider（read-only，不修改 registry）
   *   2. 按 DEFAULT_CONCURRENCY 分块，并发拉取
   *   3. 每个 provider：fetchProviderModels → updateModelParams（fail-open）
   *   4. 价格不在此处自动拉取（provider 价格 API 各异，留给手动 / 未来扩展）
   *   5. 汇总结果，写入 _lastSync
   *
   * @param {{concurrency?: number, providerIds?: string[]}} [options]
   * @returns {Promise<{total: number, succeeded: number, failed: number, results: Array, startedAt: string, finishedAt: string}>}
   */
  async syncAll(options = {}) {
    const startedAt = new Date().toISOString();
    if (this._syncing) {
      return {
        total: 0, succeeded: 0, failed: 0, results: [],
        startedAt, finishedAt: startedAt, error: "sync already in progress",
      };
    }
    this._syncing = true;
    try {
      const concurrency = options.concurrency || DEFAULT_CONCURRENCY;
      const ids = options.providerIds
        ? options.providerIds
        : REGISTRY.map((e) => e.id);
      const chunks = chunk(ids, concurrency);
      const results = [];
      for (const batch of chunks) {
        const batchResults = await Promise.all(
          batch.map((id) => this._syncOne(id))
        );
        results.push(...batchResults);
      }
      const succeeded = results.filter((r) => !r.error).length;
      const failed = results.length - succeeded;
      const finishedAt = new Date().toISOString();
      this._lastSync = { total: results.length, succeeded, failed, results, startedAt, finishedAt };
      console.log(`[${TAG}] syncAll done: ${succeeded}/${results.length} ok, ${failed} failed`);
      return this._lastSync;
    } finally {
      this._syncing = false;
    }
  }

  /**
   * 同步单个 provider 的内部实现（fetch + updateParams）。
   * fail-open：任何错误都汇聚到返回值的 error/fetchError 字段。
   *
   * 语义：
   *   - error：硬失败（无法获得任何模型数据）
   *   - fetchError：软失败（HTTP 拉取失败但回退到静态列表，仍算成功）
   */
  async _syncOne(providerId) {
    try {
      const fetchResult = await this.fetchProviderModels(providerId);
      const paramsResult = await this.updateModelParams(providerId, fetchResult.models);
      const hasModels = fetchResult.models.length > 0;
      const hardError = !hasModels
        ? (fetchResult.error || paramsResult.error || "no models available")
        : paramsResult.error || null;
      return {
        providerId,
        modelsCount: fetchResult.models.length,
        source: fetchResult.source,
        paramsUpdated: paramsResult.updated,
        error: hardError,
        fetchError: hasModels ? fetchResult.error || null : null,
      };
    } catch (e) {
      return { providerId, modelsCount: 0, paramsUpdated: 0, error: e?.message || String(e) };
    }
  }

  /**
   * 启动定时同步调度器（单例）。
   * @param {number} [intervalMs=DEFAULT_SYNC_INTERVAL_MS]
   * @returns {NodeJS.Timeout|null} interval handle
   */
  startSyncScheduler(intervalMs = DEFAULT_SYNC_INTERVAL_MS) {
    if (this._intervalHandle) return this._intervalHandle;
    this._firstRunHandle = setTimeout(() => {
      this._firstRunHandle = null;
      this.syncAll().catch(() => {});
    }, FIRST_SYNC_DELAY_MS);
    if (typeof this._firstRunHandle.unref === "function") this._firstRunHandle.unref();
    this._intervalHandle = setInterval(() => {
      this.syncAll().catch(() => {});
    }, intervalMs);
    if (typeof this._intervalHandle.unref === "function") this._intervalHandle.unref();
    console.log(`[${TAG}] scheduler started: first in ${FIRST_SYNC_DELAY_MS / 1000}s, then every ${Math.round(intervalMs / 3600000)}h`);
    return this._intervalHandle;
  }

  /**
   * 停止定时同步调度器（幂等）。
   */
  stopSyncScheduler() {
    if (this._firstRunHandle) {
      clearTimeout(this._firstRunHandle);
      this._firstRunHandle = null;
    }
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  /**
   * 查询最近一次同步状态（只读快照）。
   */
  getSyncStatus() {
    return {
      syncing: this._syncing,
      lastSync: this._lastSync,
      schedulerRunning: this._intervalHandle !== null,
    };
  }
}

// 单例导出
export const modelSyncService = new ModelSyncService();

// 便捷函数导出（与 task 要求的 API 对齐）
export const syncAll = (options) => modelSyncService.syncAll(options);
export const fetchProviderModels = (providerId) => modelSyncService.fetchProviderModels(providerId);
export const updateModelParams = (providerId, models) => modelSyncService.updateModelParams(providerId, models);
export const updateModelPricing = (providerId, pricing) => modelSyncService.updateModelPricing(providerId, pricing);

export default modelSyncService;
