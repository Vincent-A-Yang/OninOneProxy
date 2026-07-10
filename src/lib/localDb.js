// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
// Kept for backward compatibility with existing imports.
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl,
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
  exportDb, importDb,
  // F3 Response cache
  getCacheStats, getTopCacheEntries, clearAllCache, deleteExpiredCache,
  clearCacheForProvider, clearCacheForModel,
  getSemanticEntriesByModelProvider,
  // F2 Smart Router state
  getRouterState, saveRouterState, getAllRouterStates, deleteRouterState,
  // F6 Provider rate/quota limits
  getAllLimits, getLimitById, getLimitsByProvider, getLimitForSource, getLimitForModel,
  saveLimit, deleteLimit, toggleLimit,
  // Meta store (key-value _meta table)
  getMeta, setMeta,
} from "@/lib/db/index.js";
