/**
 * Task 10: Model Sync API
 *
 * Endpoints:
 *   GET   /api/models/sync          — last sync status + current config
 *   POST  /api/models/sync          — trigger a sync run
 *                                     body: { providerId?: string, force?: boolean }
 *   PATCH /api/models/sync          — update sync config
 *                                     body: { modelSyncEnabled?, modelSyncFrequency? }
 *
 * Backed by open-sse/services/modelSync.js (Task 9):
 *   - modelSyncService.syncAll() / fetchProviderModels(id)
 *   - modelSyncService.getSyncStatus()
 *
 * Notes:
 *   - syncAll is fail-open and never throws; conflicts are reported via
 *     status.syncing → 409, or via result.error when force=true bypasses
 *     the pre-check (underlying syncAll still refuses concurrent runs).
 *   - PATCH applies the new schedule immediately (fail-open).
 */
import { NextResponse } from "next/server";
import { modelSyncService } from "open-sse/services/modelSync.js";
import { getSettings, updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

// Frequency → scheduler interval (ms). "manual" = no auto schedule.
const FREQ_TO_INTERVAL_MS = {
  hourly: 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  manual: 0,
};

const VALID_FREQS = ["hourly", "12h", "daily", "manual"];

export async function GET() {
  try {
    const status = modelSyncService.getSyncStatus();
    const settings = await getSettings();
    return NextResponse.json({
      syncing: !!status.syncing,
      lastSync: status.lastSync || null,
      schedulerRunning: !!status.schedulerRunning,
      modelSyncEnabled: settings.modelSyncEnabled === true,
      modelSyncFrequency: settings.modelSyncFrequency || "manual",
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.log("Error getting model sync status:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function POST(request) {
  try {
    const status = modelSyncService.getSyncStatus();

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const providerId = body?.providerId && typeof body.providerId === "string"
      ? body.providerId
      : null;
    const force = body?.force === true;

    // Concurrent sync guard. force=true skips the 409 pre-check, but the
    // underlying syncAll still refuses concurrent runs and returns an error
    // object — so force only changes the HTTP status, not the safety.
    if (status.syncing && !force) {
      return NextResponse.json(
        { success: false, error: "sync already in progress" },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }

    const startedAt = new Date().toISOString();
    let result;
    if (providerId) {
      result = await syncSingleProvider(providerId, startedAt);
    } else {
      result = await modelSyncService.syncAll();
    }

    const payload = buildSyncResponse(result);
    return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.log("Error triggering model sync:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};
    if (typeof body?.modelSyncEnabled === "boolean") {
      updates.modelSyncEnabled = body.modelSyncEnabled;
    }
    if (typeof body?.modelSyncFrequency === "string" && VALID_FREQS.includes(body.modelSyncFrequency)) {
      updates.modelSyncFrequency = body.modelSyncFrequency;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "no valid fields to update" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const settings = await updateSettings(updates);
    applySchedulerFromSettings(settings);

    return NextResponse.json({
      modelSyncEnabled: settings.modelSyncEnabled === true,
      modelSyncFrequency: settings.modelSyncFrequency || "manual",
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.log("Error updating model sync config:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

// --- helpers -------------------------------------------------------------

async function syncSingleProvider(providerId, startedAt) {
  const fetchResult = await modelSyncService.fetchProviderModels(providerId);
  const paramsResult = await modelSyncService.updateModelParams(providerId, fetchResult.models);
  const hasModels = fetchResult.models.length > 0;
  const hardError = !hasModels
    ? (fetchResult.error || paramsResult.error || "no models available")
    : paramsResult.error || null;
  return {
    total: 1,
    succeeded: hasModels ? 1 : 0,
    failed: hasModels ? 0 : 1,
    results: [{
      providerId,
      modelsCount: fetchResult.models.length,
      source: fetchResult.source,
      paramsUpdated: paramsResult.updated,
      error: hardError,
      fetchError: hasModels ? fetchResult.error || null : null,
    }],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function buildSyncResponse(result) {
  const synced = result.succeeded || 0;
  const failed = result.failed || 0;
  const total = result.total || 0;
  const duration = result.startedAt && result.finishedAt
    ? new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()
    : null;
  const errors = (result.results || [])
    .filter((r) => r.error)
    .map((r) => ({ providerId: r.providerId, error: r.error }));
  return {
    success: !result.error,
    synced,
    failed,
    total,
    duration,
    errors,
    ...(result.error ? { error: result.error } : {}),
  };
}

// Apply scheduler start/stop based on settings (fail-open).
function applySchedulerFromSettings(settings) {
  try {
    const freq = settings.modelSyncFrequency || "manual";
    const intervalMs = FREQ_TO_INTERVAL_MS[freq] || 0;
    const enabled = settings.modelSyncEnabled === true;
    if (enabled && intervalMs > 0) {
      modelSyncService.startSyncScheduler(intervalMs);
    } else {
      modelSyncService.stopSyncScheduler();
    }
  } catch (e) {
    console.warn("[MODEL-SYNC] scheduler apply failed:", e?.message || String(e));
  }
}
