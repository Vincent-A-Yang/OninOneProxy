import { describe, it, expect } from "vitest";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { PONYTAIL_LEVELS, PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// ─── injectPonytail: OpenAI-shaped formats ─────────────────────────────────

describe("injectPonytail — OpenAI shape", () => {
  it("prepends a system message when none exists (lite level)", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE);
    expect(body.messages[0].role).toBe("system");
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content.length).toBeGreaterThan(0);
  });

  it("appends to an existing string system message (full level)", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    };
    const original = body.messages[0].content;
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.FULL);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content.startsWith(original)).toBe(true);
    // The lazy-senior-dev persona must be appended after the original prompt.
    expect(body.messages[0].content).toContain("lazy senior developer");
  });

  it("appends a new part to an array-form system content (ultra level)", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "base instructions" }],
        },
        { role: "user", content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.ULTRA);
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content.length).toBe(2);
    // New part is pushed onto the array.
    expect(body.messages[0].content[1].text).toContain("YAGNI extremist");
  });

  it("falls back to string assignment when system content is non-string non-array", () => {
    const body = {
      messages: [{ role: "system", content: null }, { role: "user", content: "hi" }],
    };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE);
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("lazy senior developer");
  });

  it("injects into OpenAI Responses `input[]` array when no messages[]", () => {
    const body = { input: [{ role: "user", content: "hi" }] };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE);
    expect(body.input[0].role).toBe("system");
    expect(typeof body.input[0].content).toBe("string");
  });

  it("injects into OpenAI Responses top-level `instructions` string", () => {
    const body = { instructions: "Be brief.", input: [{ role: "user", content: "hi" }] };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE);
    expect(body.instructions.startsWith("Be brief.")).toBe(true);
    expect(body.instructions).toContain("lazy senior developer");
  });
});

// ─── injectPonytail: Claude shape ───────────────────────────────────────────

describe("injectPonytail — Claude shape", () => {
  it("appends to a string body.system", () => {
    const body = { system: "Existing system prompt.", messages: [] };
    injectPonytail(body, FORMATS.CLAUDE, PONYTAIL_LEVELS.FULL);
    expect(body.system.startsWith("Existing system prompt.")).toBe(true);
    expect(body.system).toContain("lazy senior developer");
  });

  it("pushes a text block into an array body.system", () => {
    const body = {
      system: [{ type: "text", text: "existing" }],
      messages: [],
    };
    injectPonytail(body, FORMATS.CLAUDE, PONYTAIL_LEVELS.ULTRA);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system.length).toBe(2);
    expect(body.system[1].text).toContain("YAGNI extremist");
  });

  it("inserts before the last cache_control block to keep injection inside the cached prefix", () => {
    const body = {
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "cached-end", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    };
    injectPonytail(body, FORMATS.CLAUDE, PONYTAIL_LEVELS.LITE);
    // The ponytail block must be inserted *before* the cache_control block.
    expect(body.system.length).toBe(3);
    expect(body.system[1].text).toContain("lazy senior developer");
    expect(body.system[2].cache_control).toBeDefined();
  });

  it("initialises body.system to the prompt string when absent", () => {
    const body = { messages: [] };
    injectPonytail(body, FORMATS.CLAUDE, PONYTAIL_LEVELS.FULL);
    expect(typeof body.system).toBe("string");
    expect(body.system).toContain("lazy senior developer");
  });
});

// ─── injectPonytail: Gemini shape ──────────────────────────────────────────

describe("injectPonytail — Gemini shape", () => {
  it("appends to an existing system_instruction.parts array", () => {
    const body = {
      system_instruction: { parts: [{ text: "existing" }] },
      contents: [],
    };
    injectPonytail(body, FORMATS.GEMINI, PONYTAIL_LEVELS.FULL);
    expect(body.system_instruction.parts.length).toBe(2);
    expect(body.system_instruction.parts[1].text).toContain("lazy senior developer");
  });

  it("initialises systemInstruction (camelCase, SDK convention) when both snake_case and camelCase absent", () => {
    const body = { contents: [] };
    injectPonytail(body, FORMATS.GEMINI, PONYTAIL_LEVELS.LITE);
    // Implementation prefers camelCase (SDK convention) when neither is present.
    expect(body.systemInstruction).toBeDefined();
    expect(Array.isArray(body.systemInstruction.parts)).toBe(true);
    expect(body.systemInstruction.parts[0].text).toContain("lazy senior developer");
  });

  it("uses snake_case system_instruction when present (Gemini API convention)", () => {
    const body = {
      system_instruction: { parts: [{ text: "base" }] },
      contents: [],
    };
    injectPonytail(body, FORMATS.GEMINI, PONYTAIL_LEVELS.ULTRA);
    expect(body.system_instruction).toBeDefined();
    expect(body.systemInstruction).toBeUndefined();
  });

  it("uses camelCase systemInstruction when snake_case absent (SDK convention)", () => {
    const body = {
      systemInstruction: { parts: [{ text: "base" }] },
      contents: [],
    };
    injectPonytail(body, FORMATS.GEMINI, PONYTAIL_LEVELS.LITE);
    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts.length).toBe(2);
  });

  it("drills into Antigravity-wrapped body.request when present", () => {
    const body = {
      request: {
        system_instruction: { parts: [{ text: "wrapped" }] },
        contents: [],
      },
    };
    injectPonytail(body, FORMATS.ANTIGRAVITY, PONYTAIL_LEVELS.FULL);
    expect(body.request.system_instruction.parts.length).toBe(2);
    expect(body.request.system_instruction.parts[1].text).toContain("lazy senior developer");
  });
});

// ─── injectPonytail: fail-open contract ────────────────────────────────────

describe("injectPonytail — fail-open contract", () => {
  it("does not throw when body is null", () => {
    expect(() => injectPonytail(null, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE)).not.toThrow();
  });

  it("does not throw when body is undefined", () => {
    expect(() => injectPonytail(undefined, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE)).not.toThrow();
  });

  it("does not throw when body has no messages/input/system fields", () => {
    const body = { foo: "bar" };
    expect(() => injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.LITE)).not.toThrow();
    // Unrelated fields are preserved untouched.
    expect(body.foo).toBe("bar");
    expect(body.messages).toBeUndefined();
  });

  it("does not throw when level is unknown (no prompt to inject)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(() => injectPonytail(body, FORMATS.OPENAI, "nonexistent-level")).not.toThrow();
    // No system message should be added because there is no prompt text.
    expect(body.messages[0].role).toBe("user");
  });

  it("does not throw when prompt is undefined", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(() => injectPonytail(body, FORMATS.OPENAI, undefined)).not.toThrow();
    expect(body.messages.length).toBe(1);
  });

  it("does not mutate unrelated shape keys (e.g. tools/metadata)", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "noop" } }],
      metadata: { requestId: "abc" },
    };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.FULL);
    expect(body.tools.length).toBe(1);
    expect(body.metadata.requestId).toBe("abc");
  });
});

// ─── YAGNI ladder — level intensity progression ────────────────────────────

describe("Ponytail YAGNI ladder intensity", () => {
  it("every level key has a matching prompt and vice versa", () => {
    const levelValues = Object.values(PONYTAIL_LEVELS);
    const promptKeys = Object.keys(PONYTAIL_PROMPTS);
    for (const level of levelValues) {
      expect(promptKeys).toContain(level);
    }
    for (const key of promptKeys) {
      expect(levelValues).toContain(key);
    }
  });

  it("has a non-empty prompt string for every level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(typeof PONYTAIL_PROMPTS[level]).toBe("string");
      expect(PONYTAIL_PROMPTS[level].length).toBeGreaterThan(0);
    }
  });

  it("includes the shared persona (lazy senior developer) in every level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toContain("lazy senior developer");
    }
  });

  it("includes the YAGNI ladder reference in every level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toMatch(/YAGNI|ladder/i);
    }
  });

  it("includes the no-unrequested-abstractions rule in every level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toContain("No unrequested abstractions");
    }
  });

  it("includes the active-every-response persistence reminder in every level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toContain("ACTIVE EVERY RESPONSE");
    }
  });

  it("intensifies YAGNI extremism from LITE → FULL → ULTRA", () => {
    const lite = PONYTAIL_PROMPTS[PONYTAIL_LEVELS.LITE];
    const full = PONYTAIL_PROMPTS[PONYTAIL_LEVELS.FULL];
    const ultra = PONYTAIL_PROMPTS[PONYTAIL_LEVELS.ULTRA];
    // LITE offers the lazier alternative; ULTRA enforces deletion-first.
    expect(lite).toContain("name the lazier alternative");
    // FULL prompt uses "the ladder enforced" (lowercase, matches PONYTAIL_PROMPTS).
    expect(full).toMatch(/the ladder enforced/i);
    expect(ultra).toContain("YAGNI extremist");
    // All three must be distinct strings.
    expect(new Set([lite, full, ultra]).size).toBe(3);
  });

  it("keeps the deletion-over-addition rule consistent across all levels", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toContain("Deletion over addition");
    }
  });

  it("never simplifies away security/validation at any level", () => {
    for (const level of Object.values(PONYTAIL_LEVELS)) {
      expect(PONYTAIL_PROMPTS[level]).toContain("input validation");
      expect(PONYTAIL_PROMPTS[level]).toContain("security");
    }
  });
});

// ─── End-to-end: injection actually applies the configured prompt ──────────

describe("injectPonytail — end-to-end prompt application", () => {
  it("the injected system prompt matches PONYTAIL_PROMPTS[level] for OpenAI string form", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectPonytail(body, FORMATS.OPENAI, PONYTAIL_LEVELS.FULL);
    // The freshly-prepended system message content should equal the FULL prompt.
    expect(body.messages[0].content).toBe(PONYTAIL_PROMPTS[PONYTAIL_LEVELS.FULL]);
  });

  it("the injected Claude array block text matches PONYTAIL_PROMPTS[level]", () => {
    const body = { system: [], messages: [] };
    injectPonytail(body, FORMATS.CLAUDE, PONYTAIL_LEVELS.LITE);
    expect(body.system[0].text).toBe(PONYTAIL_PROMPTS[PONYTAIL_LEVELS.LITE]);
  });

  it("the injected Gemini systemInstruction.parts[0].text matches PONYTAIL_PROMPTS[level]", () => {
    const body = { contents: [] };
    injectPonytail(body, FORMATS.GEMINI, PONYTAIL_LEVELS.ULTRA);
    // When both snake_case and camelCase absent, implementation uses camelCase (SDK convention).
    expect(body.systemInstruction.parts[0].text).toBe(PONYTAIL_PROMPTS[PONYTAIL_LEVELS.ULTRA]);
  });
});
