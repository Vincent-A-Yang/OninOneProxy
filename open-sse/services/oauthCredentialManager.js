import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";
import { createLruMap } from "../utils/lruMap.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import {
  acquireAccountSlot,
  resolveJitterMs,
  sleep,
  recordOAuthError,
  recordOAuthSuccess,
  isAccountCoolingDown,
} from "./oauthAntiBan.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

// Stage 11.1.2: bounded LRU for in-flight refresh locks. Previously this was
// an unbounded Map — a burst of distinct credential refreshes could
// accumulate entries faster than .finally() could clean them up. The LRU
// ceiling (refreshLocksMaxSize, default 500) caps the worst case; eviction
// only drops the lock, not the pending Promise itself, so any in-flight
// caller still receives its result. A subsequent request for an evicted key
// simply starts a new refresh — safe, at most a minor duplication.
const refreshLocks = createLruMap({
  maxEntries: MEMORY_CONFIG.refreshLocksMaxSize,
  onEvict: (key) => {
    // Eviction is informational only — the pending Promise resolves on its
    // own; we just no longer dedupe future requests against it.
  },
});

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (expiresAtMs !== null && expiresAtMs - nowMs < getRefreshLeadMs(provider)) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn, log) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  // Stage 5.4: anti-ban guards (fail-open on every path).
  // 1) If the account is in cooldown (429/403 spike), skip refresh entirely
  //    and let the caller fall through to the next source.
  // 2) Acquire a per-account concurrency slot. When the cap is reached we
  //    don't queue here — `acquireAccountSlot` returns null and the caller
  //    proceeds without a slot (fail-open: refresh runs anyway rather than
  //    blocking the user's request indefinitely).
  // 3) Apply a small jitter delay before the refresh to de-sync parallel
  //    refreshes from different accounts (defends against fingerprinting).
  // 4) On 429/403 from the refresh itself, record the error so the
  //    sliding-window monitor can trigger cooldown.
  if (isAccountCoolingDown(key)) {
    log?.debug?.("OAUTH_ANTI_BAN", `Account ${key} in cooldown — skipping refresh (fail-open).`);
    return null;
  }

  const releaseSlot = acquireAccountSlot(key);
  const jitterMs = resolveJitterMs(provider);
  if (jitterMs > 0) {
    log?.debug?.("OAUTH_ANTI_BAN", `Applying ${jitterMs}ms jitter before refresh of ${key}.`);
  }

  const pending = Promise.resolve()
    .then(async () => {
      if (jitterMs > 0) await sleep(jitterMs);
      try {
        const result = await refreshFn();
        recordOAuthSuccess(key);
        return result;
      } catch (err) {
        const status = err?.status || err?.statusCode || err?.response?.status;
        if (status === 429 || status === 403) {
          recordOAuthError(key, status, log);
        }
        throw err;
      }
    })
    .finally(() => {
      if (releaseSlot) releaseSlot();
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

export async function refreshProviderCredentials(provider, credentials, log) {
  if (!credentials) return null;

  return withCredentialRefreshLock(provider, credentials, async () => {
    const refreshed = await refreshTokenByProvider(provider, credentials, log);
    return mergeRefreshedCredentials(provider, credentials, refreshed);
  }, log);
}
