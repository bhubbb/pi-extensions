/**
 * tests/context-policy.test.mjs — tests for src/context-policy.ts
 *
 * Tests:
 * 1. renderEntry renders user/assistant/toolResult correctly
 * 2. stripReasoning drops thinking blocks
 * 3. keepToolResults controls toolResult visibility
 * 4. selectTail keeps first user + last N + omitted marker
 * 5. buildAdvisorPayload assembles correct output per mode
 * 6. D3 fallback (summary undefined → tail shape)
 * 7. Import/initialize the extension — makes sure the module doesn't explode
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// ── Helpers to build test entries ───────────────────────────────────────────

function userEntry(content) {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: content }] },
  };
}

function assistantEntry(content) {
  return {
    type: "message",
    message: { role: "assistant", content },
  };
}

function toolResultEntry(toolName, content, isError = false) {
  return {
    type: "message",
    message: { role: "toolResult", toolName, content: [{ type: "text", text: content }], isError },
  };
}

// ── renderEntry ─────────────────────────────────────────────────────────────

describe("context-policy.ts — renderEntry", () => {
  it("renders user entry", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const result = renderEntry(userEntry("Hello world"));
    assert.ok(result?.startsWith("## User"));
    assert.ok(result?.includes("Hello world"));
  });

  it("renders assistant text content", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "text", text: "I will help you." },
    ]);
    const result = renderEntry(entry);
    assert.ok(result?.startsWith("## Assistant"));
    assert.ok(result?.includes("I will help you."));
  });

  it("renders assistant with toolCall", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "toolCall", name: "edit", arguments: { path: "src/foo.ts", edits: [] } },
    ]);
    const result = renderEntry(entry);
    assert.ok(result?.includes("called `edit`"));
    assert.ok(result?.includes("src/foo.ts"));
  });

  it("renders toolResult", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = toolResultEntry("bash", "Command succeeded", false);
    const result = renderEntry(entry);
    assert.ok(result?.includes("Result of `bash`"));
    assert.ok(result?.includes("Command succeeded"));
  });

  it("renders error toolResult", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = toolResultEntry("bash", "exit code 1", true);
    const result = renderEntry(entry);
    assert.ok(result?.includes("(error)"));
  });

  it("returns null for invalid entry", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    assert.equal(renderEntry({}), null);
    assert.equal(renderEntry({ type: "other" }), null);
  });

  it("returns null for assistant with no content", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([]);
    const result = renderEntry(entry);
    assert.equal(result, null);
  });
});

// ── renderEntry with stripReasoning ─────────────────────────────────────────

describe("context-policy.ts — stripReasoning", () => {
  it("includes thinking blocks when stripReasoning=false", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "Done thinking." },
    ]);
    const result = renderEntry(entry, { stripReasoning: false });
    assert.ok(result?.includes("[reasoning]"));
    assert.ok(result?.includes("Let me think about this..."));
  });

  it("strips thinking blocks when stripReasoning=true", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "Done thinking." },
    ]);
    const result = renderEntry(entry, { stripReasoning: true });
    assert.ok(result?.includes("Done thinking."));
    assert.ok(!result?.includes("[reasoning]"));
    assert.ok(!result?.includes("Let me think about this..."));
  });

  it("default stripReasoning is true", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "visible" },
    ]);
    const result = renderEntry(entry); // no opts → stripReasoning defaults true
    assert.ok(!result?.includes("secret reasoning"));
  });

  it("strips reasoning in toolResult (no-op, but doesn't crash)", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = toolResultEntry("read", "file content", false);
    const result = renderEntry(entry, { stripReasoning: true });
    assert.ok(result?.includes("file content"));
  });

  it("handles assistant with only thinking (stripped → null)", async () => {
    const { renderEntry } = await import("../src/context-policy.mjs");
    const entry = assistantEntry([
      { type: "thinking", thinking: "only thinking here" },
    ]);
    const result = renderEntry(entry, { stripReasoning: true });
    assert.equal(result, null);
  });
});

// ── selectTail ──────────────────────────────────────────────────────────────

describe("context-policy.ts — selectTail", () => {
  it("returns all entries if length <= tailMessages", async () => {
    const { selectTail } = await import("../src/context-policy.mjs");
    const entries = [userEntry("msg1"), userEntry("msg2")];
    const result = selectTail(entries, 5);
    assert.equal(result.kept.length, 2);
    assert.equal(result.omittedCount, 0);
    assert.equal(result.firstUserReInserted, false);
  });

  it("keeps first user message when it falls outside window", async () => {
    const { selectTail } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task framing"),
      userEntry("msg2"),
      userEntry("msg3"),
      userEntry("msg4"),
      userEntry("msg5"),
    ];
    const result = selectTail(entries, 3);
    assert.equal(result.kept.length, 3);
    assert.ok(result.firstUserReInserted);
    assert.equal(result.omittedCount, 2);
  });

  it("keeps last N entries when first user is in window", async () => {
    const { selectTail } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("msg1"),
      userEntry("msg2"),
      userEntry("msg3"),
      userEntry("msg4"),
    ];
    const result = selectTail(entries, 3);
    assert.equal(result.kept.length, 3);
    assert.equal(result.firstUserReInserted, false);
    assert.equal(result.omittedCount, 1);
  });

  it("skips non-message entries in count", async () => {
    const { selectTail } = await import("../src/context-policy.mjs");
    const entries = [
      { type: "other", message: { role: "user" } },
      userEntry("real msg1"),
      { type: "message", message: { role: "assistant", content: [] } }, // empty assistant
      userEntry("real msg2"),
    ];
    const result = selectTail(entries, 2);
    assert.equal(result.omittedCount, 1);
  });

  it("returns empty for empty entries", async () => {
    const { selectTail } = await import("../src/context-policy.mjs");
    const result = selectTail([], 5);
    assert.equal(result.kept.length, 0);
    assert.equal(result.omittedCount, 0);
    assert.equal(result.firstUserReInserted, false);
  });
});

// ── buildAdvisorPayload ─────────────────────────────────────────────────────

describe("context-policy.ts — buildAdvisorPayload", () => {
  const model = { maxTokens: 4096, contextWindow: 128000 };
  const opts = {
    tailMessages: 5,
    stripReasoning: true,
    keepToolResults: "recent",
    diffDigest: "Changed files:\n  src/foo.ts  +10/-3",
    summary: "The user wants a function that adds numbers.",
  };

  it("full mode renders all entries", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("Add two numbers"),
      assistantEntry([{ type: "text", text: "I'll create a function." }]),
      assistantEntry([
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Here is the code." },
      ]),
    ];
    const result = buildAdvisorPayload(entries, "full", opts, model);
    assert.ok(result.includes("Add two numbers"));
    assert.ok(result.includes("I'll create a function."));
    assert.ok(result.includes("Here is the code."));
    // stripReasoning should hide thinking
    assert.ok(!result.includes("Let me think..."));
  });

  it("tail mode shows task framing + last N + diff digest", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task framing"),
      userEntry("msg2"),
      userEntry("msg3"),
      assistantEntry([{ type: "text", text: "recent msg" }]),
    ];
    const result = buildAdvisorPayload(entries, "tail", opts, model);
    assert.ok(result.includes("task framing"));
    assert.ok(result.includes("recent msg"));
    assert.ok(result.includes("Changed files:"));
    assert.ok(result.includes("src/foo.ts"));
  });

  it("summary mode shows summary + diff + last 2-3", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work done" }]),
      userEntry("msg3"),
    ];
    const result = buildAdvisorPayload(entries, "summary", opts, model);
    assert.ok(result.includes("[Summary]"));
    assert.ok(result.includes("The user wants a function"));
    assert.ok(result.includes("[Changed files]"));
    assert.ok(result.includes("[Last messages]"));
  });

  it("summary+tail mode shows summary + diff + tail", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "msg2" }]),
      userEntry("msg3"),
      assistantEntry([{ type: "text", text: "msg4" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary+tail", opts, model);
    assert.ok(result.includes("[Summary]"));
    assert.ok(result.includes("[Changed files]"));
    assert.ok(result.includes("[Recent transcript]"));
  });

  it("D3 fallback: summary undefined → tail shape", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary", { ...opts, summary: undefined }, model);
    assert.ok(result.includes("[summary unavailable — showing recent transcript]"));
    assert.ok(result.includes("task"));
  });

  it("D3 fallback: summary+tail undefined → tail shape", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary+tail", { ...opts, summary: undefined }, model);
    assert.ok(result.includes("[summary unavailable — showing recent transcript]"));
    assert.ok(result.includes("task"));
  });

  it("empty entries return empty string", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const result = buildAdvisorPayload([], "full", opts, model);
    assert.equal(result, "");
  });

  it("full mode with no stripReasoning keeps thinking", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy.mjs");
    const entries = [
      assistantEntry([
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "visible" },
      ]),
    ];
    const result = buildAdvisorPayload(entries, "full", { ...opts, stripReasoning: false }, model);
    assert.ok(result.includes("secret reasoning"));
  });
});

// ── Import & initialization ─────────────────────────────────────────────────

describe("context-policy.ts — import & initialization", () => {
  it("module loads without throwing (no pi context required)", async () => {
    const {
      renderEntry,
      selectTail,
      buildAdvisorPayload,
      truncate,
    } = await import("../src/context-policy.mjs");

    assert.ok(typeof renderEntry === "function");
    assert.ok(typeof selectTail === "function");
    assert.ok(typeof buildAdvisorPayload === "function");
    assert.ok(typeof truncate === "function");

    // Quick smoke test: renderEntry and selectTail are callable
    const entry = userEntry("hello");
    const rendered = renderEntry(entry, { stripReasoning: true, showToolResults: true });
    assert.ok(rendered?.includes("hello"));

    const tailResult = selectTail([entry], 5);
    assert.ok(Array.isArray(tailResult.kept));
    assert.equal(tailResult.kept.length, 1);
  });
});
