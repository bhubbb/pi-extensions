/**
 * tests/todo-trigger.test.mjs — tests for the isTodoCompletion detection helper.
 *
 * Tests the pure function in isolation. The function is defined inline here
 * to avoid importing advisor.ts (which requires pi modules). The inline
 * implementation must match the one in advisor.ts.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Inline copy of the pure helper from advisor.ts — must stay in sync.
function isTodoCompletion(input, details) {
  if (!input || typeof input !== "object") return false;
  const inp = input;

  // Rich tool: action "update" with status "completed" in input
  if (inp.action === "update" && inp.status === "completed") return true;
  // Rich tool: action "update" with status in result details
  if (inp.action === "update" && details && typeof details === "object" && details.status === "completed") return true;
  // Example toggle tool: action "toggle" with done: true in result details
  if (inp.action === "toggle" && details && typeof details === "object" && details.done === true) return true;

  return false;
}

describe("isTodoCompletion — rich status tool", async function () {
  it("returns true for update + status: completed in input", () => {
    assert.equal(
      isTodoCompletion({ action: "update", id: 1, status: "completed" }, undefined),
      true,
    );
  });

  it("returns false for update + status: in_progress", () => {
    assert.equal(
      isTodoCompletion({ action: "update", id: 1, status: "in_progress" }, undefined),
      false,
    );
  });

  it("returns true for update with status: completed in details", () => {
    assert.equal(
      isTodoCompletion({ action: "update", id: 1 }, { status: "completed" }),
      true,
    );
  });

  it("returns false for update with status: pending in details", () => {
    assert.equal(
      isTodoCompletion({ action: "update", id: 1 }, { status: "pending" }),
      false,
    );
  });
});

describe("isTodoCompletion — example toggle tool", async function () {
  it("returns true for toggle with done: true in details", () => {
    assert.equal(
      isTodoCompletion({ action: "toggle", id: 1 }, { done: true, id: 1 }),
      true,
    );
  });

  it("returns false for toggle with done: false in details (un-completing)", () => {
    assert.equal(
      isTodoCompletion({ action: "toggle", id: 1 }, { done: false, id: 1 }),
      false,
    );
  });
});

describe("isTodoCompletion — unrelated actions", async function () {
  it("returns false for list action", () => {
    assert.equal(isTodoCompletion({ action: "list" }, undefined), false);
  });

  it("returns false for create action", () => {
    assert.equal(isTodoCompletion({ action: "create", subject: "do thing" }, undefined), false);
  });

  it("returns false for delete action", () => {
    assert.equal(isTodoCompletion({ action: "delete", id: 1 }, undefined), false);
  });

  it("returns false for clear action", () => {
    assert.equal(isTodoCompletion({ action: "clear" }, undefined), false);
  });
});

describe("isTodoCompletion — unexpected / missing input", async function () {
  it("returns false for null input", () => {
    assert.equal(isTodoCompletion(null, undefined), false);
  });

  it("returns false for undefined input", () => {
    assert.equal(isTodoCompletion(undefined, undefined), false);
  });

  it("returns false for string input", () => {
    assert.equal(isTodoCompletion("not an object", undefined), false);
  });

  it("returns false for array input", () => {
    assert.equal(isTodoCompletion([], undefined), false);
  });

  it("returns false for empty object input", () => {
    assert.equal(isTodoCompletion({}, undefined), false);
  });
});
