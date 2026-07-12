import { describe, it, expect, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .clone().json() surface the engine uses.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return make();
}

describe("fusion combo", () => {
  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(([, m]) => m !== "p/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel).toBeUndefined();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });

  // F1: primary/backup failover — primary fails (non-2xx) → backup is tried.
  it("F1: activates backup model when primary returns non-2xx", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-a") return errResponse(500);
      if (model === "p/backup-a") return okResponse("backup-answer");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-a", backup: "p/backup-a" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });

    // Primary tried first, then backup, then panel b, then judge.
    expect(seen).toContain("p/primary-a");
    expect(seen).toContain("p/backup-a");
    expect(seen).toContain("p/b");
    expect(seen.at(-1)).toBe("p/judge");

    // Judge sees backup's answer (not primary's failure).
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("backup-answer");
    expect(judgeText).toContain("ans-p/b");
  });

  // F1: primary succeeds → backup is never called.
  it("F1: skips backup when primary succeeds", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary") return okResponse("primary-answer");
      if (model === "p/backup") return okResponse("should-not-happen");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary", backup: "p/backup" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(seen).toContain("p/primary");
    expect(seen).not.toContain("p/backup");
  });

  // F1: both primary and backup fail → slot contributes nothing, fusion proceeds with rest.
  it("F1: returns 503 when all slots (primary+backup) fail", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/a", backup: "p/a-backup" }, { primary: "p/b", backup: "p/b-backup" }],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
    // 2 primaries + 2 backups tried = 4 total calls.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
  });

  // F1: disableFailover flag strips backups — primary failure is not retried.
  it("F1: disableFailover=true skips backup attempts", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary") return errResponse(500);
      if (model === "p/backup") return okResponse("backup-answer");
      if (model === "p/b") return okResponse("ans-p/b");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary", backup: "p/backup" }, "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000, disableFailover: true },
    });

    // Primary tried (fails), backup NOT tried, p/b tried, no judge (only 1 answer).
    expect(seen).toContain("p/primary");
    expect(seen).not.toContain("p/backup");
    expect(seen).toContain("p/b");
    // Lone survivor → answered directly (no judge).
    expect(res.ok).toBe(true);
  });

  // === F1 boundary tests (Stage F1.5 / F5.1) ===

  // F1: empty panel (models=[]) → 400 Bad Request.
  it("F1: returns 400 when panel has no models", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("x"));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [],
      handleSingleModel,
      log,
    });
    expect(res.status).toBe(400);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  // F1: all panel models time out → 503.
  it("F1: returns 503 when all panel models time out", async () => {
    const handleSingleModel = vi.fn(async () => {
      // Never resolves within the hard timeout.
      return new Promise(() => {});
    });
    const t0 = Date.now();
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 200 },
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(503);
    // Should not wait much longer than the hard timeout.
    expect(elapsed).toBeLessThan(1500);
  });

  // F1: primary times out → D2 analyzeError classifies status=0 as "fail" → skipBackup.
  it("F1: D2 skipBackup when primary times out (analyzeError: non-HTTP failure → strategy=fail)", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-t") {
        // Hangs past the hard timeout.
        return new Promise(() => {});
      }
      if (model === "p/backup-t") return okResponse("backup-from-timeout");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-t", backup: "p/backup-t" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 200 },
    });

    // D2: primary times out → tryModel returns {ok:false, reason:"timeout"} (no status/bodyText/headers)
    // → analyzeError(0, "", {}, "p") → strategy="fail" → skipBackup=true → backup NOT called
    expect(seen).not.toContain("p/backup-t");
    // Only "p/b" succeeds → answers.length === 1 → direct answer, no judge
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeUndefined();
    // Final response comes from "p/b" directly (no fusion)
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("ans-p/b");
  });

  // F1: primary throws → D2 analyzeError classifies status=0 as "fail" → skipBackup.
  it("F1: D2 skipBackup when primary throws (analyzeError: non-HTTP failure → strategy=fail)", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-throw") throw new Error("network failure");
      if (model === "p/backup-throw") return okResponse("backup-from-throw");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-throw", backup: "p/backup-throw" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // D2: primary throws → tryModel returns {ok:false, reason:"throw:..."} (no status/bodyText/headers)
    // → analyzeError(0, "", {}, "p") → strategy="fail" → skipBackup=true → backup NOT called
    expect(seen).toContain("p/primary-throw");
    expect(seen).not.toContain("p/backup-throw");
    // Only "p/b" succeeds → answers.length === 1 → direct answer, no judge
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeUndefined();
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("ans-p/b");
  });

  // F1: primary returns 200 but empty content → D2 analyzeError classifies status=0 as "fail" → skipBackup.
  it("F1: D2 skipBackup when primary returns empty content (analyzeError: non-HTTP failure → strategy=fail)", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-empty") return okResponse("");
      if (model === "p/backup-empty") return okResponse("backup-from-empty");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-empty", backup: "p/backup-empty" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // D2: primary returns empty → tryModel returns {ok:false, reason:"empty"} (no status/bodyText/headers)
    // → analyzeError(0, "", {}, "p") → strategy="fail" → skipBackup=true → backup NOT called
    expect(seen).toContain("p/primary-empty");
    expect(seen).not.toContain("p/backup-empty");
    // Only "p/b" succeeds → answers.length === 1 → direct answer, no judge
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeUndefined();
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("ans-p/b");
  });

  // F1: primary returns 200 but unparseable JSON body → D2 analyzeError classifies status=0 as "fail" → skipBackup.
  it("F1: D2 skipBackup when primary returns unparseable body (analyzeError: non-HTTP failure → strategy=fail)", async () => {
    // A response stub whose .json() throws (simulating non-JSON upstream body).
    const unparseableResponse = {
      ok: true,
      status: 200,
      clone: () => unparseableResponse,
      json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
    };
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-bad") return unparseableResponse;
      if (model === "p/backup-bad") return okResponse("backup-from-unparseable");
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-bad", backup: "p/backup-bad" }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // D2: primary returns unparseable → tryModel returns {ok:false, reason:"unparseable:..."} (no status/bodyText/headers)
    // → analyzeError(0, "", {}, "p") → strategy="fail" → skipBackup=true → backup NOT called
    expect(seen).toContain("p/primary-bad");
    expect(seen).not.toContain("p/backup-bad");
    // Only "p/b" succeeds → answers.length === 1 → direct answer, no judge
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeUndefined();
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("ans-p/b");
  });

  // F1: no backup configured → primary failure surfaces as slot failure (no retry).
  it("F1: slot with null backup surfaces primary failure without retry", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-no-backup") return errResponse(500);
      if (model === "p/b") return okResponse("ans-p/b");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    // Slot with explicit backup: null → normalizePanel keeps it as {primary, backup:null}.
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/primary-no-backup", backup: null }, "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // Primary tried (fails), no backup retried, p/b succeeds → judge called.
    expect(seen).toContain("p/primary-no-backup");
    // No extra call for a backup model.
    expect(seen.filter((m) => m !== "p/primary-no-backup" && m !== "p/b" && m !== "p/judge")).toHaveLength(0);
  });

  // F1: mixed string and {primary,backup} slots normalize correctly.
  it("F1: mixes string[] and {primary,backup} slots in the same panel", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/p1") return errResponse(500);
      if (model === "p/bk1") return okResponse("backup-1");
      if (model === "p/p2") return okResponse("plain-2");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [{ primary: "p/p1", backup: "p/bk1" }, "p/p2"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // Slot 0: primary fails → backup tried. Slot 1: plain string, succeeds.
    expect(seen).toContain("p/p1");
    expect(seen).toContain("p/bk1");
    expect(seen).toContain("p/p2");
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("backup-1");
    expect(judgeText).toContain("plain-2");
  });

  // ─── F5.1: F1 boundary tests ──────────────────────────────────────────────

  // F5.1 boundary: primary AND backup both fail in one slot, but another
  // slot succeeds → the failing slot contributes nothing, and since only one
  // answer remains the engine returns it directly (no judge synthesis).
  it("F5.1 boundary: backup also fails — lone survivor answers directly without judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      if (model === "p/primary-dead") return errResponse(500);
      if (model === "p/backup-dead") return errResponse(502);
      if (model === "p/survivor") return okResponse("lone-survivor-answer");
      if (model === "p/judge") return okResponse("SHOULD-NOT-HAPPEN");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: [
        { primary: "p/primary-dead", backup: "p/backup-dead" },
        "p/survivor",
      ],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });

    // Both primary and backup of slot 0 were attempted.
    expect(seen).toContain("p/primary-dead");
    expect(seen).toContain("p/backup-dead");
    expect(seen).toContain("p/survivor");
    // Only one answer succeeded → engine returns it directly (no judge call).
    expect(handleSingleModel).not.toHaveBeenCalledWith(
      expect.anything(),
      "p/judge"
    );
    // The direct response is the survivor's, re-issued as a fresh call.
    expect(res.ok).toBe(true);
  });

  // ─── F4.3: maxPanelConcurrency verification ─────────────────────────────────

  // F4.3: a small maxPanelConcurrency caps how many panel calls are in flight
  // at once. With 10 slots and cap=3, peak in-flight must never exceed 3.
  it("F4.3: maxPanelConcurrency limits in-flight panel calls", async () => {
    let inFlight = 0;
    let peak = 0;
    // Only track PANEL calls (isPanel === true). The judge call is NOT subject
    // to maxPanelConcurrency — it runs after collectPanel returns (possibly
    // overlapping with zombie panel calls that were already launched). Counting
    // the judge in the same inFlight counter would produce a flaky peak of
    // cap+1 whenever the judge starts before a zombie panel call finishes.
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
      }
      // Small delay so concurrency is observable.
      await new Promise((r) => setTimeout(r, 20));
      if (isPanel) {
        inFlight--;
      }
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const panel = Array.from({ length: 10 }, (_, i) => `p/m${i}`);
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: panel,
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { maxPanelConcurrency: 3, minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });

    // Cap of 3 must hold — peak in-flight never exceeds 3.
    expect(peak).toBeLessThanOrEqual(3);
    // All 10 panel models were still called (concurrency limits parallelism, not total).
    for (const m of panel) {
      expect(handleSingleModel.mock.calls.some(([, called]) => called === m)).toBe(true);
    }
  });

  // F4.3: the default maxPanelConcurrency (8) must not throttle a small panel
  // of 3 — all three should run fully in parallel (wall time ≈ one slot, not 3×).
  it("F4.3: default maxPanelConcurrency does not throttle small panels", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      await new Promise((r) => setTimeout(r, 50));
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      // Default maxPanelConcurrency=8, minPanel=2, etc.
    });
    const elapsed = Date.now() - t0;
    // If throttled to 1-at-a-time, wall time would be ~150ms (3×50).
    // With default cap=8 ≥ 3, all run in parallel → ~50ms + judge 50ms ≈ 100ms.
    // Allow generous headroom for CI jitter but assert it's well under serial.
    expect(elapsed).toBeLessThan(130);
  });

  // ─── Roles: per-model role prompt injection ────────────────────────────────

  // R1: a roleed model receives a system message prepended with the role prompt.
  it("R1: injects role system message when roles config maps a model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { roles: { "p/a": "researcher" } },
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    // p/a is roleed → its body has a leading system message.
    const callA = panelCalls.find(([, m]) => m === "p/a");
    const bodyA = callA[0];
    expect(bodyA.messages[0]).toEqual({ role: "system", content: expect.stringContaining("meticulous researcher") });
    expect(bodyA.messages[1]).toEqual({ role: "user", content: "Q" });
    expect(bodyA.messages.length).toBe(2);

    // p/b is unroleed → no system message injected, body unchanged.
    const callB = panelCalls.find(([, m]) => m === "p/b");
    const bodyB = callB[0];
    expect(bodyB.messages[0]).toEqual({ role: "user", content: "Q" });
    expect(bodyB.messages.length).toBe(1);
    // Unroleed body must not carry a system message at all.
    expect(bodyB.messages.some((m) => m.role === "system")).toBe(false);
  });

  // R2: regression — no roles config → panel bodies are byte-identical to the
  // original Fusion behavior (no system message, same message count).
  it("R2: no roles config → panel bodies unchanged (backward compatible)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const body = { messages: [{ role: "user", content: "Q" }] };
    await handleFusionChat({
      body,
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      // No `roles` in tuning → cfg.roles is null.
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    expect(panelCalls.length).toBe(3);
    for (const [panelBody] of panelCalls) {
      // Exactly one message — the original user turn. No system message added.
      expect(panelBody.messages.length).toBe(1);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "Q" });
      expect(panelBody.messages.some((m) => m.role === "system")).toBe(false);
    }
  });

  // R3: roles config present but model not in map → unroleed (no system msg).
  it("R3: roles config present but model unmapped → unroleed body", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { roles: { "p/nonexistent": "researcher" } },
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    for (const [panelBody] of panelCalls) {
      expect(panelBody.messages.length).toBe(1);
      expect(panelBody.messages.some((m) => m.role === "system")).toBe(false);
    }
  });

  // R4: unknown role name → treated as unroleed (getRolePrompt returns "").
  it("R4: unknown role name → unroleed body (no crash)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { roles: { "p/a": "totally-bogus-role" } },
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    for (const [panelBody] of panelCalls) {
      expect(panelBody.messages.length).toBe(1);
      expect(panelBody.messages.some((m) => m.role === "system")).toBe(false);
    }
  });

  // R5: Poe-style models (no tools support) with a role still get tools stripped.
  // Role prompts never require tool calling, so a non-tool model works as a role.
  it("R5: roleed panel model still has tools stripped", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [{ role: "user", content: "Q" }],
        tools: [{ type: "function", function: { name: "search" } }],
        tool_choice: "auto",
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { roles: { "p/a": "researcher", "p/b": "coder" } },
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.tool_choice).toBeUndefined();
      // System message present (both models are roleed).
      expect(panelBody.messages[0].role).toBe("system");
    }
  });

  // R6: judgeRole prefix is prepended to the judge prompt.
  it("R6: judgeRole prefix prepended to judge prompt", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { judgeRole: "judge-strict" },
    });

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    // The strict prefix must appear before the standard JUDGE directive.
    expect(judgeText.startsWith("Apply extra scrutiny:")).toBe(true);
    expect(judgeText).toContain("You are the JUDGE");
    // Panel answers are still present.
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
  });

  // R7: judgeRole unknown → default judge prompt (no prefix, no crash).
  it("R7: unknown judgeRole → default judge prompt (no crash)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { judgeRole: "does-not-exist" },
    });

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    // No prefix → starts with the standard JUDGE directive.
    expect(judgeText.startsWith("You are the JUDGE")).toBe(true);
  });

  // R8: roles + judgeRole combined — both panel and judge get role directives.
  it("R8: roles and judgeRole compose correctly", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Write a function" }] },
      models: ["p/coder", "p/reviewer"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: {
        roles: { "p/coder": "coder", "p/reviewer": "reviewer" },
        judgeRole: "judge-code",
      },
    });

    const panelCalls = handleSingleModel.mock.calls.filter(
      ([, m, isPanel]) => m !== "p/judge" && isPanel === true
    );
    const coderBody = panelCalls.find(([, m]) => m === "p/coder")[0];
    const reviewerBody = panelCalls.find(([, m]) => m === "p/reviewer")[0];

    expect(coderBody.messages[0].content).toContain("senior software engineer");
    expect(reviewerBody.messages[0].content).toContain("rigorous code and design reviewer");

    const judgeText = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge")[0].messages.at(-1).content;
    expect(judgeText.startsWith("For code requests:")).toBe(true);
    expect(judgeText).toContain("ans-p/coder");
  });
});
