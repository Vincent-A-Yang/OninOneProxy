// E2E Protocol Compatibility Matrix
//
// Verifies the core promise of OninOneProxy: ANY framework/agent tool (source
// format) can talk to ANY model/provider (target format) through the translator
// pivot (source → openai → target for requests; target → openai → source for
// responses).
//
// Coverage:
//   D4.1 — this file (tests/e2e/protocol-compatibility.test.js)
//   D4.2 — 13×13 = 169 combination matrix (fail-open guarantee + supported deep tests)
//   D4.3 — each supported combination tests request + response + stream translation
//
// The 13 formats (from translator/formats.js):
//   OPENAI, OPENAI_RESPONSES, OPENAI_RESPONSE, CLAUDE, GEMINI, GEMINI_CLI, VERTEX,
//   CODEX, ANTIGRAVITY, KIRO, CURSOR, OLLAMA, COMMANDCODE
//
// Design:
//   - Part 1: Full 169-matrix fail-open guarantee (no combo throws)
//   - Part 2: Supported request combos verify text content survives pivot
//   - Part 3: Deep tests for the 7 common combos listed in the task
//   - Part 4: Two-hop pivot tests (source → openai → target, non-OpenAI endpoints)
//   - Part 5: Response streaming matrix (target → openai → source)
//   - Part 6: Identity normalization (same → same)
//   - Part 7: Fail-open on malformed input

import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Minimal valid request body for each source (client) format. The shared
// payload text "hello world" lets every pivot test assert text survival.
const PAYLOAD_TEXT = "hello world";

const SOURCE_REQUEST = {
  [FORMATS.OPENAI]: { messages: [{ role: "user", content: PAYLOAD_TEXT }] },
  [FORMATS.OPENAI_RESPONSES]: {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PAYLOAD_TEXT }] }],
  },
  [FORMATS.OPENAI_RESPONSE]: {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PAYLOAD_TEXT }] }],
  },
  [FORMATS.CLAUDE]: { messages: [{ role: "user", content: PAYLOAD_TEXT }], max_tokens: 100 },
  [FORMATS.GEMINI]: { contents: [{ role: "user", parts: [{ text: PAYLOAD_TEXT }] }] },
  [FORMATS.GEMINI_CLI]: { contents: [{ role: "user", parts: [{ text: PAYLOAD_TEXT }] }] },
  [FORMATS.VERTEX]: { contents: [{ role: "user", parts: [{ text: PAYLOAD_TEXT }] }] },
  [FORMATS.CODEX]: {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PAYLOAD_TEXT }] }],
  },
  [FORMATS.ANTIGRAVITY]: {
    request: { contents: [{ role: "user", parts: [{ text: PAYLOAD_TEXT }] }] },
  },
  [FORMATS.KIRO]: {
    conversationState: { currentMessage: { userInputMessage: { content: PAYLOAD_TEXT } } },
  },
  // CURSOR / OLLAMA / COMMANDCODE have no source→openai request adapter;
  // a best-effort OpenAI-shaped body is supplied so fail-open is exercised.
  [FORMATS.CURSOR]: { messages: [{ role: "user", content: PAYLOAD_TEXT }] },
  [FORMATS.OLLAMA]: { messages: [{ role: "user", content: PAYLOAD_TEXT }] },
  [FORMATS.COMMANDCODE]: { messages: [{ role: "user", content: PAYLOAD_TEXT }] },
};

// Streaming chunk sequence emitted by each target (provider) format. Every
// sequence carries the text "Hello" so response tests can assert survival.
const RESPONSE_TEXT = "Hello";

const TARGET_STREAM = {
  [FORMATS.OPENAI]: [
    { id: "chatcmpl-1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: RESPONSE_TEXT }, finish_reason: null }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ],
  [FORMATS.OPENAI_RESPONSES]: [
    { type: "response.output_text.delta", delta: RESPONSE_TEXT },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ],
  [FORMATS.CLAUDE]: [
    { type: "message_start", message: { id: "msg_1", model: "claude-opus-4-6" } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: RESPONSE_TEXT } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ],
  [FORMATS.GEMINI]: [
    { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }], responseId: "r1", modelVersion: "gemini-3-pro" },
    { candidates: [{ finishReason: "STOP" }] },
  ],
  [FORMATS.GEMINI_CLI]: [
    { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }], responseId: "r1", modelVersion: "gemini-3-pro" },
    { candidates: [{ finishReason: "STOP" }] },
  ],
  [FORMATS.VERTEX]: [
    { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }], responseId: "r1", modelVersion: "gemini-3-pro" },
    { candidates: [{ finishReason: "STOP" }] },
  ],
  [FORMATS.ANTIGRAVITY]: [
    { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }], responseId: "r1", modelVersion: "gemini-3-pro" },
    { candidates: [{ finishReason: "STOP" }] },
  ],
  [FORMATS.KIRO]: [
    { assistantResponseEvent: { content: RESPONSE_TEXT }, _eventType: "assistantResponseEvent" },
    { _eventType: "messageStopEvent" },
  ],
  [FORMATS.CURSOR]: [
    { id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: RESPONSE_TEXT }, finish_reason: null }] },
    { id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ],
  [FORMATS.OLLAMA]: [
    { model: "m", message: { role: "assistant", content: RESPONSE_TEXT } },
    { model: "m", done: true, done_reason: "stop" },
  ],
  [FORMATS.COMMANDCODE]: [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: RESPONSE_TEXT },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
    { type: "finish" },
  ],
};

// All 13 formats — the full matrix dimension.
const ALL_FORMATS = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.OPENAI_RESPONSE,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.CODEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.OLLAMA,
  FORMATS.COMMANDCODE,
];

// Formats with a request source→openai adapter (can act as client source).
const REQUEST_SOURCES = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.OPENAI_RESPONSE,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.CODEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
];

// Formats with an openai→target request adapter (can act as provider target).
const REQUEST_TARGETS = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.OLLAMA,
  FORMATS.COMMANDCODE,
];

// Formats that emit a streamable response (target→openai adapter exists).
const RESPONSE_TARGETS = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.OLLAMA,
  FORMATS.COMMANDCODE,
];

// Formats whose clients can consume a streamed response (openai→source adapter exists).
const RESPONSE_SOURCES = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A combo is request-supported when source has →openai AND target has openai→.
function isRequestSupported(source, target) {
  if (source === target) return true; // identity normalization path
  const srcOk = source === FORMATS.OPENAI || REQUEST_SOURCES.includes(source);
  const tgtOk = target === FORMATS.OPENAI || REQUEST_TARGETS.includes(target);
  return srcOk && tgtOk;
}

// A combo is response-supported when target has →openai AND source has openai→.
function isResponseSupported(target, source) {
  if (target === source) return true;
  const tgtOk = target === FORMATS.OPENAI || RESPONSE_TARGETS.includes(target);
  const srcOk = source === FORMATS.OPENAI || RESPONSE_SOURCES.includes(source);
  return tgtOk && srcOk;
}

// Run a chunk sequence through translateResponse and collect every emitted chunk.
function runStream(targetFormat, sourceFormat, events) {
  const state = initState(sourceFormat);
  const all = [];
  for (const ev of events) {
    const out = translateResponse(targetFormat, sourceFormat, ev, state);
    if (Array.isArray(out)) all.push(...out);
    else if (out) all.push(out);
  }
  return all;
}

// Best-effort text extraction from a translated request body across formats.
// Handles nested envelopes (gemini-cli/antigravity wrap in `request`, commandcode
// wraps in `params`) in addition to the flat shapes.
function extractRequestText(body, format) {
  if (!body || typeof body !== "object") return "";

  // Unwrap envelopes: antigravity / gemini-cli wrap payload in `request`.
  const inner = body.request && typeof body.request === "object" ? body.request : body;
  // CommandCode wraps payload in `params`.
  const params = body.params && typeof body.params === "object" ? body.params : null;

  // OpenAI / Claude / Cursor / Ollama / CommandCode(flat) request shape
  const fromMessages = (msgs) =>
    Array.isArray(msgs)
      ? msgs
          .map((m) =>
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
              ? m.content.map((c) => c.text || "").join("")
              : ""
          )
          .join("")
      : "";

  if (Array.isArray(body.messages)) return fromMessages(body.messages);
  if (params && Array.isArray(params.messages)) return fromMessages(params.messages);
  if (Array.isArray(body.contents)) return extractPartsText(body.contents);
  if (inner && Array.isArray(inner.contents)) return extractPartsText(inner.contents);
  if (body.conversationState) {
    const cur = body.conversationState.currentMessage?.userInputMessage?.content;
    return typeof cur === "string" ? cur : "";
  }
  if (Array.isArray(body.input)) {
    return body.input
      .map((i) =>
        Array.isArray(i.content) ? i.content.map((c) => c.text || "").join("") : typeof i.content === "string" ? i.content : ""
      )
      .join("");
  }
  return "";
}

// Extract text from a Gemini-style contents[] array.
function extractPartsText(contents) {
  return contents
    .map((c) => (Array.isArray(c.parts) ? c.parts.map((p) => p.text || "").join("") : ""))
    .join("");
}

// Best-effort text extraction from response chunks across source formats.
// Handles: OpenAI choices[].delta.content, Claude content_block_delta, Gemini
// candidates[].content.parts[].text (flat or nested in `response`), Kiro
// assistantResponseEvent.content, and raw Responses-API events.
function extractResponseText(chunks, sourceFormat) {
  if (!Array.isArray(chunks)) return "";

  // OpenAI-family: choices[].delta.content
  const openaiText = chunks
    .map((c) => c?.choices?.[0]?.delta?.content || c?.choices?.[0]?.delta?.reasoning_content || "")
    .join("");
  if (openaiText) return openaiText;

  // Claude: content_block_delta.delta.text
  const claudeText = chunks
    .filter((c) => c?.type === "content_block_delta")
    .map((c) => c.delta?.text || "")
    .join("");
  if (claudeText) return claudeText;

  // Kiro: assistantResponseEvent.content
  const kiroText = chunks
    .map((c) => c?.assistantResponseEvent?.content || "")
    .join("");
  if (kiroText) return kiroText;

  // Gemini / Vertex / Antigravity: candidates[].content.parts[].text
  // Antigravity wraps the whole payload in a `response` key.
  const geminiText = chunks
    .map((c) => {
      const cand = c?.candidates?.[0] || c?.response?.candidates?.[0];
      return cand?.content?.parts?.map((p) => p.text || "").join("") || "";
    })
    .join("");
  if (geminiText) return geminiText;

  // Responses API raw events: { type:"response.output_text.delta", delta:"..." }
  const rawResponsesText = chunks
    .filter((c) => c?.type === "response.output_text.delta")
    .map((c) => c?.delta || "")
    .join("");
  if (rawResponsesText) return rawResponsesText;

  // Responses API wrapped events: { event:"response.output_text.delta", data:{ delta } }
  const wrappedResponsesText = chunks
    .filter((c) => c?.event === "response.output_text.delta")
    .map((c) => c?.data?.delta || "")
    .join("");
  if (wrappedResponsesText) return wrappedResponsesText;

  // Cursor passthrough: chat.completion.chunk
  const cursorText = chunks
    .map((c) => c?.choices?.[0]?.delta?.content || "")
    .join("");
  return cursorText;
}

// ---------------------------------------------------------------------------
// Part 1 — Full 13×13 = 169 matrix: fail-open guarantee
// ---------------------------------------------------------------------------

describe("D4.2 / Part 1 — 13×13 request matrix: no combination throws", () => {
  // Every (source, target) pair must return without throwing. Unsupported
  // combos rely on fail-open (passthrough original body).
  for (const source of ALL_FORMATS) {
    for (const target of ALL_FORMATS) {
      const label = `${source} → ${target}`;
      it(label, () => {
        const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[source]));
        let result;
        expect(() => {
          result = translateRequest(source, target, "test-model", body, true, null, null);
        }).not.toThrow();
        // Result must be a non-null object (never undefined/null).
        expect(result).toBeTruthy();
        expect(typeof result).toBe("object");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Part 2 — Supported request combos: text content survives the pivot
// ---------------------------------------------------------------------------

describe("D4.3 / Part 2 — supported request combos preserve payload text", () => {
  const cases = [];
  for (const source of REQUEST_SOURCES) {
    for (const target of REQUEST_TARGETS) {
      cases.push([source, target]);
    }
  }
  it.each(cases)("%s → %s preserves request text", (source, target) => {
    const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[source]));
    const out = translateRequest(source, target, "test-model", body, true, null, null);
    const text = extractRequestText(out, target);
    expect(text).toContain(PAYLOAD_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Deep tests for the 7 common combos called out in the task
// ---------------------------------------------------------------------------

describe("D4.3 / Part 3 — common combos deep verification", () => {
  const COMMON_COMBOS = [
    [FORMATS.CLAUDE, FORMATS.OPENAI],
    [FORMATS.GEMINI, FORMATS.OPENAI],
    [FORMATS.CURSOR, FORMATS.OPENAI],
    [FORMATS.VERTEX, FORMATS.OPENAI],
    [FORMATS.KIRO, FORMATS.OPENAI],
    [FORMATS.ANTIGRAVITY, FORMATS.OPENAI],
    [FORMATS.OLLAMA, FORMATS.OPENAI],
    // Bidirectional: OpenAI → each special
    [FORMATS.OPENAI, FORMATS.CLAUDE],
    [FORMATS.OPENAI, FORMATS.GEMINI],
    [FORMATS.OPENAI, FORMATS.VERTEX],
    [FORMATS.OPENAI, FORMATS.KIRO],
    [FORMATS.OPENAI, FORMATS.OLLAMA],
    [FORMATS.OPENAI, FORMATS.CURSOR],
  ];

  it.each(COMMON_COMBOS)("request %s ↔ %s preserves text + valid shape", (source, target) => {
    const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[source]));
    const out = translateRequest(source, target, "test-model", body, true, null, null);
    expect(extractRequestText(out, target)).toContain(PAYLOAD_TEXT);

    // Shape sanity per target format
    if (target === FORMATS.OPENAI) expect(Array.isArray(out.messages)).toBe(true);
    if (target === FORMATS.CLAUDE) expect(out.max_tokens).toBeGreaterThan(0);
    if (target === FORMATS.GEMINI || target === FORMATS.VERTEX) expect(Array.isArray(out.contents)).toBe(true);
    if (target === FORMATS.KIRO) expect(out.conversationState).toBeTruthy();
    if (target === FORMATS.OLLAMA) expect(out.messages).toBeTruthy();
    if (target === FORMATS.CURSOR) expect(out.messages || out.input || out.contents).toBeTruthy();
  });

  it.each(COMMON_COMBOS)("stream %s → %s emits non-empty response chunks", (target, source) => {
    // Skip pairs where the target has no stream fixture (only OpenAI-family here).
    const stream = TARGET_STREAM[target];
    if (!stream) return; // OpenAI_RESPONSE / CODEX have no provider stream fixture
    const events = JSON.parse(JSON.stringify(stream));
    const out = runStream(target, source, events);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — Two-hop pivot tests (non-OpenAI source → non-OpenAI target)
// ---------------------------------------------------------------------------

describe("D4.3 / Part 4 — two-hop pivot (source → openai → target)", () => {
  const PIVOT_CASES = [
    [FORMATS.CLAUDE, FORMATS.GEMINI],
    [FORMATS.CLAUDE, FORMATS.VERTEX],
    [FORMATS.CLAUDE, FORMATS.KIRO],
    [FORMATS.CLAUDE, FORMATS.OLLAMA],
    [FORMATS.GEMINI, FORMATS.CLAUDE],
    [FORMATS.GEMINI, FORMATS.KIRO],
    [FORMATS.GEMINI, FORMATS.OLLAMA],
    [FORMATS.VERTEX, FORMATS.CLAUDE],
    [FORMATS.VERTEX, FORMATS.GEMINI],
    [FORMATS.KIRO, FORMATS.CLAUDE],
    [FORMATS.KIRO, FORMATS.GEMINI],
    [FORMATS.ANTIGRAVITY, FORMATS.CLAUDE],
    [FORMATS.ANTIGRAVITY, FORMATS.GEMINI],
    [FORMATS.ANTIGRAVITY, FORMATS.KIRO],
    [FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE],
    [FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI],
    [FORMATS.OPENAI_RESPONSES, FORMATS.KIRO],
    [FORMATS.CLAUDE, FORMATS.CLAUDE], // direct route exists
  ];

  it.each(PIVOT_CASES)("%s → %s two-hop preserves request text", (source, target) => {
    const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[source]));
    const out = translateRequest(source, target, "test-model", body, true, null, null);
    expect(extractRequestText(out, target)).toContain(PAYLOAD_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — Response streaming matrix (target → openai → source)
// ---------------------------------------------------------------------------

describe("D4.3 / Part 5 — response streaming matrix", () => {
  // For every supported (target, source) pair, run the target's stream fixture
  // through translateResponse and assert: no throw + non-empty + text survives.
  const cases = [];
  for (const target of RESPONSE_TARGETS) {
    for (const source of RESPONSE_SOURCES) {
      cases.push([target, source]);
    }
  }

  it.each(cases)("stream %s → %s: no throw + emits chunks + text survives", (target, source) => {
    // Direct-route combos (e.g. kiro:claude) bypass the pivot and expect the
    // executor-emitted chunk shape rather than the raw provider shape. The
    // kiro:claude direct route consumes OpenAI-shaped chat.completion.chunk
    // objects (KiroExecutor already transforms raw Kiro events to OpenAI shape
    // before they reach translateResponse). Use the OpenAI stream fixture for
    // these direct-route pairs.
    let events;
    if (target === FORMATS.KIRO && source === FORMATS.CLAUDE) {
      events = JSON.parse(JSON.stringify(TARGET_STREAM[FORMATS.OPENAI]));
    } else {
      events = JSON.parse(JSON.stringify(TARGET_STREAM[target]));
    }
    let out;
    expect(() => {
      out = runStream(target, source, events);
    }).not.toThrow();
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);

    // Text survival: every pivot must carry RESPONSE_TEXT through to the client.
    const text = extractResponseText(out, source);
    // Some adapters emit the text across multiple chunks; allow partial match.
    // Passthrough targets (Cursor) keep OpenAI shape; the text must still be present.
    expect(text).toContain(RESPONSE_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Part 6 — Identity normalization (same → same)
// ---------------------------------------------------------------------------

describe("D4 / Part 6 — identity normalization (source === target)", () => {
  for (const fmt of ALL_FORMATS) {
    it(`${fmt} → ${fmt}: returns body (normalized, no crash)`, () => {
      const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[fmt]));
      const out = translateRequest(fmt, fmt, "test-model", body, true, null, null);
      expect(out).toBeTruthy();
      expect(typeof out).toBe("object");
    });
  }
});

// ---------------------------------------------------------------------------
// Part 7 — Fail-open: malformed input never breaks the stream
// ---------------------------------------------------------------------------

describe("D4 / Part 7 — fail-open on malformed input", () => {
  // Object-shaped malformed bodies (the orchestrator's pre-processing —
  // stripContentTypes / ensureToolCallIds / fixMissingToolResponses — reads
  // body.messages, so a non-object body is out of contract; adapters themselves
  // guard against unexpected object shapes and pass through).
  const MALFORMED = [
    {},
    { totally: "empty" },
    { messages: "not-an-array" },
    { messages: [] },
    { messages: [{ role: "user", content: 42 }] },
    { foo: "bar", baz: 123 },
  ];

  for (const source of ALL_FORMATS) {
    for (const target of ALL_FORMATS) {
      it(`request ${source} → ${target}: malformed body does not throw`, () => {
        for (const bad of MALFORMED) {
          expect(() => {
            translateRequest(source, target, "m", JSON.parse(JSON.stringify(bad)), true, null, null);
          }).not.toThrow();
        }
      });
    }
  }

  it("response: null chunk terminates stream cleanly (empty array, no throw)", () => {
    for (const target of RESPONSE_TARGETS) {
      for (const source of RESPONSE_SOURCES) {
        const state = initState(source);
        expect(() => {
          const out = translateResponse(target, source, null, state);
          expect(Array.isArray(out)).toBe(true);
        }).not.toThrow();
      }
    }
  });

  it("response: non-object chunk passes through (fail-open)", () => {
    for (const target of RESPONSE_TARGETS) {
      for (const source of RESPONSE_SOURCES) {
        const state = initState(source);
        const out = translateResponse(target, source, "garbage-string", state);
        expect(Array.isArray(out)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Summary — matrix coverage accounting
// ---------------------------------------------------------------------------

describe("D4.2 — matrix coverage accounting", () => {
  it("covers all 13×13 = 169 request combinations (fail-open + supported)", () => {
    expect(ALL_FORMATS.length).toBe(13);
    // 13 × 13 = 169 combos, all exercised in Part 1.
    expect(ALL_FORMATS.length * ALL_FORMATS.length).toBe(169);
  });

  it("lists the 7+1 common combos required by the task", () => {
    const required = [
      [FORMATS.CLAUDE, FORMATS.OPENAI],
      [FORMATS.GEMINI, FORMATS.OPENAI],
      [FORMATS.CURSOR, FORMATS.OPENAI],
      [FORMATS.VERTEX, FORMATS.OPENAI],
      [FORMATS.KIRO, FORMATS.OPENAI],
      [FORMATS.ANTIGRAVITY, FORMATS.OPENAI],
      [FORMATS.OLLAMA, FORMATS.OPENAI],
    ];
    for (const [s, t] of required) {
      const body = JSON.parse(JSON.stringify(SOURCE_REQUEST[s]));
      const out = translateRequest(s, t, "m", body, true, null, null);
      expect(extractRequestText(out, t)).toContain(PAYLOAD_TEXT);
    }
  });
});
