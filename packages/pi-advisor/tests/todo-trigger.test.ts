/**
 * tests/todo-trigger.test.ts — tests for the isTodoCompletion detection helper.
 *
 * Tests the pure function in isolation. The function is defined inline here
 * to avoid importing advisor.ts (which requires pi modules). The inline
 * implementation must match the one in advisor.ts.
 */

import { describe, it, expect } from "bun:test";

// Inline copy of the pure helper from advisor.ts — must stay in sync.
function isTodoCompletion(input: unknown, details: unknown) {
  if (!input || typeof input !== "object") return false;
  const inp = input as Record<string, unknown>;

  // Rich tool: action "update" with status "completed" in input
  if (inp.action === "update" && inp.status === "completed") return true;
  // Rich tool: action "update" with status in result details
  if (inp.action === "update" && details && typeof details === "object" && (details as Record<string, unknown>).status === "completed") return true;
  // Example toggle tool: action "toggle" with done: true in result details
  if (inp.action === "toggle" && details && typeof details === "object" && (details as Record<string, unknown>).done === true) return true;

  return false;
}

describe("isTodoCompletion — rich status tool", () => {
  it("returns true for update + status: completed in input", () => {
    expect(
      isTodoCompletion({ action: "update", id: 1, status: "completed" }, undefined),
    ).toBe(true);
  });

  it("returns false for update + status: in_progress", () => {
    expect(
      isTodoCompletion({ action: "update", id: 1, status: "in_progress" }, undefined),
    ).toBe(false);
  });

  it("returns true for update with status: completed in details", () => {
    expect(isTodoCompletion({ action: "update", id: 1 }, { status: "completed" })).toBe(true);
  });

  it("returns false for update with status: pending in details", () => {
    expect(isTodoCompletion({ action: "update", id: 1 }, { status: "pending" })).toBe(false);
  });
});

describe("isTodoCompletion — example toggle tool", () => {
  it("returns true for toggle with done: true in details", () => {
    expect(isTodoCompletion({ action: "toggle", id: 1 }, { done: true, id: 1 })).toBe(true);
  });

  it("returns false for toggle with done: false in details (un-completing)", () => {
    expect(isTodoCompletion({ action: "toggle", id: 1 }, { done: false, id: 1 })).toBe(false);
  });
});

describe("isTodoCompletion — unrelated actions", () => {
  it("returns false for list action", () => {
    expect(isTodoCompletion({ action: "list" }, undefined)).toBe(false);
  });

  it("returns false for create action", () => {
    expect(isTodoCompletion({ action: "create", subject: "do thing" }, undefined)).toBe(false);
  });

  it("returns false for delete action", () => {
    expect(isTodoCompletion({ action: "delete", id: 1 }, undefined)).toBe(false);
  });

  it("returns false for clear action", () => {
    expect(isTodoCompletion({ action: "clear" }, undefined)).toBe(false);
  });
});

describe("isTodoCompletion — unexpected / missing input", () => {
  it("returns false for null input", () => {
    expect(isTodoCompletion(null, undefined)).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(isTodoCompletion(undefined, undefined)).toBe(false);
  });

  it("returns false for string input", () => {
    expect(isTodoCompletion("not an object", undefined)).toBe(false);
  });

  it("returns false for array input", () => {
    expect(isTodoCompletion([], undefined)).toBe(false);
  });

  it("returns false for empty object input", () => {
    expect(isTodoCompletion({}, undefined)).toBe(false);
  });
});
