import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { getRolePrompt } from "../../open-sse/services/combo.js";

describe("getRolePrompt dual-schema support", () => {
  let warnSpy;

  beforeEach(() => {
    // Capture console.warn so we can assert warning emission without polluting test output.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Scenario 1: Array format + valid modelStr + comboModels -> returns correct role prompt
  it("array format: resolves role via comboModels.indexOf(modelStr)", () => {
    const roles = ["summarizer", "devils-advocate", "coder"];
    const comboModels = ["m1", "m2", "m3"];

    // m2 is at index 1 -> roles[1] = "devils-advocate"
    const prompt = getRolePrompt(roles, "m2", comboModels);
    expect(prompt).toContain("designated skeptic");
    expect(prompt).toContain("counterarguments");

    // m1 is at index 0 -> roles[0] = "summarizer"
    const prompt0 = getRolePrompt(roles, "m1", comboModels);
    expect(prompt0).toContain("clarity specialist");

    // m3 is at index 2 -> roles[2] = "coder"
    const prompt2 = getRolePrompt(roles, "m3", comboModels);
    expect(prompt2).toContain("senior software engineer");
  });

  // Scenario 2: Object format + valid modelStr -> returns correct role prompt
  it("object format: resolves role via direct key lookup", () => {
    const roles = { "m1": "summarizer", "m2": "devils-advocate" };

    const prompt = getRolePrompt(roles, "m2");
    expect(prompt).toContain("designated skeptic");

    const prompt0 = getRolePrompt(roles, "m1");
    expect(prompt0).toContain("clarity specialist");
  });

  // Scenario 3: Array format + modelStr not in comboModels -> returns ""
  it("array format: modelStr not in comboModels returns empty string", () => {
    const roles = ["summarizer", "devils-advocate"];
    const comboModels = ["m1", "m2"];

    const prompt = getRolePrompt(roles, "m-not-in-list", comboModels);
    expect(prompt).toBe("");
    // No warning should be emitted for this case (modelStr not found is a normal "no role" case).
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Scenario 4: Empty array / empty object / null / undefined -> returns ""
  it("empty or null roles return empty string", () => {
    expect(getRolePrompt([], "m1", ["m1"])).toBe("");
    expect(getRolePrompt({}, "m1")).toBe("");
    expect(getRolePrompt(null, "m1")).toBe("");
    expect(getRolePrompt(undefined, "m1")).toBe("");
    expect(getRolePrompt(null, "m1", ["m1"])).toBe("");
    expect(getRolePrompt(undefined, "m1", ["m1"])).toBe("");
  });

  // Scenario 5: Array length mismatch with comboModels -> truncation / missing positions return ""
  it("array length mismatch: extra comboModels positions return empty, extra roles positions are ignored", () => {
    // roles has 2 entries, comboModels has 3 — index 2 is out of bounds for roles.
    const shortRoles = ["summarizer", "devils-advocate"];
    const longComboModels = ["m1", "m2", "m3"];

    expect(getRolePrompt(shortRoles, "m1", longComboModels)).toContain("clarity specialist");
    expect(getRolePrompt(shortRoles, "m2", longComboModels)).toContain("designated skeptic");
    // m3 is at index 2, but roles only has 2 entries (indices 0,1) -> "" (truncated).
    expect(getRolePrompt(shortRoles, "m3", longComboModels)).toBe("");

    // roles has 4 entries, comboModels has 2 — extra role entries are unreachable.
    const longRoles = ["summarizer", "devils-advocate", "coder", "reviewer"];
    const shortComboModels = ["m1", "m2"];
    expect(getRolePrompt(longRoles, "m1", shortComboModels)).toContain("clarity specialist");
    expect(getRolePrompt(longRoles, "m2", shortComboModels)).toContain("designated skeptic");
  });

  // Scenario 6: Array format but comboModels not passed / empty -> returns "" + warning
  it("array format without comboModels returns empty string and warns", () => {
    const roles = ["summarizer", "devils-advocate"];

    // comboModels not passed at all.
    const prompt1 = getRolePrompt(roles, "m1");
    expect(prompt1).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("getRolePrompt");
    expect(warnSpy.mock.calls[0][0]).toContain("comboModels");

    warnSpy.mockClear();

    // comboModels passed as empty array.
    const prompt2 = getRolePrompt(roles, "m1", []);
    expect(prompt2).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("comboModels");

    warnSpy.mockClear();

    // comboModels passed as null.
    const prompt3 = getRolePrompt(roles, "m1", null);
    expect(prompt3).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // Additional: unknown role name returns "" (graceful degradation).
  it("unknown role name returns empty string (both formats)", () => {
    expect(getRolePrompt({ "m1": "nonexistent-role" }, "m1")).toBe("");
    expect(getRolePrompt(["nonexistent-role"], "m1", ["m1"])).toBe("");
  });

  // Additional: empty string role value returns "" (both formats).
  it("empty string role value returns empty string", () => {
    expect(getRolePrompt({ "m1": "" }, "m1")).toBe("");
    expect(getRolePrompt([""], "m1", ["m1"])).toBe("");
  });

  // Additional: non-string role value returns "" (defensive).
  it("non-string role value returns empty string", () => {
    expect(getRolePrompt({ "m1": 123 }, "m1")).toBe("");
    expect(getRolePrompt({ "m1": null }, "m1")).toBe("");
    expect(getRolePrompt([null, undefined, 42], "m1", ["m1", "m2", "m3"])).toBe("");
  });
});
