"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

const useProviderStore = create((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  lastFetched: 0,

  setProviders: (providers) => set({ providers, lastFetched: Date.now() }),

  // Optimistic local mutation + cache invalidation. The local array is
  // updated immediately for snappy UI, but lastFetched is reset so that any
  // subsequent fetchProviders({}) (without force) goes to the network and
  // retrieves the authoritative backend state. This prevents the
  // "OmniRoute-style" front-end/back-end drift where one component mutates
  // via API but another component still reads stale cached data within
  // CLIENT_STORE_TTL_MS (60s). The mutation is only called by consumers
  // AFTER a successful POST/PUT/DELETE, so the optimistic update is safe.
  addProvider: (provider) => {
    set((state) => ({ providers: [provider, ...state.providers] }));
    get().invalidate();
  },

  updateProvider: (id, updates) => {
    set((state) => ({
      providers: state.providers.map((p) =>
        p._id === id ? { ...p, ...updates } : p
      ),
    }));
    get().invalidate();
  },

  removeProvider: (id) => {
    set((state) => ({
      providers: state.providers.filter((p) => p._id !== id),
    }));
    get().invalidate();
  },

  invalidate: () => set({ lastFetched: 0 }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  // Skips network when cache is fresh (< CLIENT_STORE_TTL_MS). Pass {force:true} to override.
  fetchProviders: async ({ force = false } = {}) => {
    const { lastFetched, providers } = get();
    if (!force && providers.length > 0 && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return;
    set({ loading: true, error: null });
    try {
      const response = await fetch("/api/providers");
      const data = await response.json();
      if (response.ok) {
        set({ providers: data.connections || data.providers || [], loading: false, lastFetched: Date.now() });
      } else {
        set({ error: data.error, loading: false });
      }
    } catch (error) {
      set({ error: "Failed to fetch providers", loading: false });
    }
  },
}));

export default useProviderStore;

