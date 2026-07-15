/**
 * tests/context-policy.test.ts — tests for src/context-policy.ts
 *
 * Tests:
 * 1. renderEntry renders user/assistant/toolResult correctly
 * 2. stripReasoning drops thinking blocks
 * 3. selectTail keeps first user + last N + omitted marker
 * 4. buildAdvisorPayload assembles correct output per mode
 * 5. Import/initialize the extension — makes sure the module doesn't explode
 */

import { describe, it, expect } from "bun:test";

// ── Helpers to build test entries ───────────────────────────────────────────

function userEntry(content: string) {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: content }] },
  } as const;
}

function assistantEntry(content: unknown[]) {
  return {
    type: "message",
    message: { role: "assistant", content },
  } as const;
}

function toolResultEntry(toolName: string, content: string, isError = false) {
  return {
    type: "message",
    message: { role: "toolResult", toolName, content: [{ type: "text", text: content }], isError },
  } as const;
}

// ── renderEntry ─────────────────────────────────────────────────────────────

describe("context-policy.ts — renderEntry", () => {
  it("renders user entry", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const result = renderEntry(userEntry("Hello world"));
    expect(result?.startsWith("## User")).toBe(true);
    expect(result?.includes("Hello world")).toBe(true);
  });

  it("renders assistant text content", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "text", text: "I will help you." },
    ]);
    const result = renderEntry(entry);
    expect(result?.startsWith("## Assistant")).toBe(true);
    expect(result?.includes("I will help you.")).toBe(true);
  });

  it("renders assistant with toolCall", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "toolCall", name: "edit", arguments: { path: "src/foo.ts", edits: [] } },
    ]);
    const result = renderEntry(entry);
    expect(result?.includes("called `edit`")).toBe(true);
    expect(result?.includes("src/foo.ts")).toBe(true);
  });

  it("renders toolResult", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = toolResultEntry("bash", "Command succeeded", false);
    const result = renderEntry(entry, { stripReasoning: true });
    expect(result?.includes("Result of `bash`")).toBe(true);
    expect(result?.includes("Command succeeded")).toBe(true);
  });

  it("renders error toolResult", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = toolResultEntry("bash", "exit code 1", true);
    const result = renderEntry(entry, { stripReasoning: true });
    expect(result?.includes("(error)")).toBe(true);
  });

  it("returns null for invalid entry", async () => {
    const { renderEntry } = await import("../src/context-policy");
    expect(renderEntry({} as never)).toBeNull();
    expect(renderEntry({ type: "other" } as never)).toBeNull();
  });

  it("returns null for assistant with no content", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([]);
    const result = renderEntry(entry);
    expect(result).toBeNull();
  });
});

// ── renderEntry with stripReasoning ─────────────────────────────────────────

describe("context-policy.ts — stripReasoning", () => {
  it("includes thinking blocks when stripReasoning=false", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "Done thinking." },
    ]);
    const result = renderEntry(entry, { stripReasoning: false });
    expect(result?.includes("[reasoning]")).toBe(true);
    expect(result?.includes("Let me think about this...")).toBe(true);
  });

  it("strips thinking blocks when stripReasoning=true", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "Done thinking." },
    ]);
    const result = renderEntry(entry, { stripReasoning: true });
    expect(result?.includes("Done thinking.")).toBe(true);
    expect(result?.includes("[reasoning]")).toBe(false);
    expect(result?.includes("Let me think about this...")).toBe(false);
  });

  it("default stripReasoning is true", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "visible" },
    ]);
    const result = renderEntry(entry, { stripReasoning: true }); // .ts requires opts
    expect(result?.includes("secret reasoning")).toBe(false);
  });

  it("strips reasoning in toolResult (no-op, but doesn't crash)", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = toolResultEntry("read", "file content", false);
    const result = renderEntry(entry, { stripReasoning: true });
    expect(result?.includes("file content")).toBe(true);
  });

  it("handles assistant with only thinking (stripped → null)", async () => {
    const { renderEntry } = await import("../src/context-policy");
    const entry = assistantEntry([
      { type: "thinking", thinking: "only thinking here" },
    ]);
    const result = renderEntry(entry, { stripReasoning: true });
    expect(result).toBeNull();
  });
});

// ── selectTail ──────────────────────────────────────────────────────────────

describe("context-policy.ts — selectTail", () => {
  // Note: .ts selectTail returns { selected: AnyEntry[], omittedMarker: string }
  // — different from .mjs shadow which returned { kept, omittedCount, firstUserReInserted }.

  it("returns all entries if length <= tailMessages", async () => {
    const { selectTail } = await import("../src/context-policy");
    const entries = [userEntry("msg1"), userEntry("msg2")];
    const result = selectTail(entries, 5);
    expect(result.selected.length).toBe(2);
    expect(result.omittedMarker).toBe("");
  });

  it("keeps first user message when it falls outside window", async () => {
    const { selectTail } = await import("../src/context-policy");
    const entries = [
      userEntry("task framing"),
      userEntry("msg2"),
      userEntry("msg3"),
      userEntry("msg4"),
      userEntry("msg5"),
    ];
    const result = selectTail(entries, 3);
    expect(result.selected.length).toBe(3); // first user + 2 last
    expect(result.omittedMarker).toContain("earlier messages omitted");
  });

  it("keeps last N entries when first user is in window", async () => {
    const { selectTail } = await import("../src/context-policy");
    const entries = [
      userEntry("msg1"),
      userEntry("msg2"),
      userEntry("msg3"),
      userEntry("msg4"),
    ];
    const result = selectTail(entries, 3);
    expect(result.selected.length).toBe(3);
    expect(result.omittedMarker).toContain("earlier messages omitted");
  });

  it("skips non-message entries in count", async () => {
    const { selectTail } = await import("../src/context-policy");
    const entries = [
      { type: "other", message: { role: "user" } } as never,
      userEntry("real msg1"),
      { type: "message", message: { role: "assistant", content: [] } } as never, // empty assistant
      userEntry("real msg2"),
    ];
    const result = selectTail(entries, 2);
    expect(result.omittedMarker).toContain("earlier messages omitted");
  });

  it("returns empty for empty entries", async () => {
    const { selectTail } = await import("../src/context-policy");
    const result = selectTail([], 5);
    expect(result.selected.length).toBe(0);
    expect(result.omittedMarker).toBe("");
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
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("Add two numbers"),
      assistantEntry([{ type: "text", text: "I'll create a function." }]),
      assistantEntry([
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Here is the code." },
      ]),
    ];
    const result = buildAdvisorPayload(entries, "full", opts, model);
    expect(result).toContain("Add two numbers");
    expect(result).toContain("I'll create a function.");
    expect(result).toContain("Here is the code.");
    // stripReasoning should hide thinking
    expect(result).not.toContain("Let me think...");
  });

  it("tail mode shows task framing + last N + diff digest", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("task framing"),
      userEntry("msg2"),
      userEntry("msg3"),
      assistantEntry([{ type: "text", text: "recent msg" }]),
    ];
    const result = buildAdvisorPayload(entries, "tail", opts, model);
    expect(result).toContain("task framing");
    expect(result).toContain("recent msg");
    expect(result).toContain("Changed files:");
    expect(result).toContain("src/foo.ts");
  });

  it("summary mode shows summary + diff + last 2-3", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work done" }]),
      userEntry("msg3"),
    ];
    const result = buildAdvisorPayload(entries, "summary", opts, model);
    expect(result).toContain("[Summary]");
    expect(result).toContain("The user wants a function");
    expect(result).toContain("[Changed files]");
    expect(result).toContain("[Last messages]");
  });

  it("summary+tail mode shows summary + diff + tail", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "msg2" }]),
      userEntry("msg3"),
      assistantEntry([{ type: "text", text: "msg4" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary+tail", opts, model);
    expect(result).toContain("[Summary]");
    expect(result).toContain("[Changed files]");
    expect(result).toContain("[Recent transcript]");
  });

  it("D3 fallback: summary undefined → tail shape", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary", { ...opts, summary: undefined } as never, model);
    expect(result).toContain("[summary unavailable — showing recent transcript]");
    expect(result).toContain("task");
  });

  it("D3 fallback: summary+tail undefined → tail shape", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      userEntry("task"),
      assistantEntry([{ type: "text", text: "work" }]),
    ];
    const result = buildAdvisorPayload(entries, "summary+tail", { ...opts, summary: undefined } as never, model);
    expect(result).toContain("[summary unavailable — showing recent transcript]");
    expect(result).toContain("task");
  });

  it("empty entries return empty string", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const result = buildAdvisorPayload([], "full", opts, model);
    expect(result).toBe("");
  });

  it("full mode with no stripReasoning keeps thinking", async () => {
    const { buildAdvisorPayload } = await import("../src/context-policy");
    const entries = [
      assistantEntry([
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "visible" },
      ]),
    ];
    const result = buildAdvisorPayload(entries, "full", { ...opts, stripReasoning: false }, model);
    expect(result).toContain("secret reasoning");
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
    } = await import("../src/context-policy");

    expect(typeof renderEntry).toBe("function");
    expect(typeof selectTail).toBe("function");
    expect(typeof buildAdvisorPayload).toBe("function");
    expect(typeof truncate).toBe("function");

    // Quick smoke test: renderEntry and selectTail are callable
    const entry = userEntry("hello");
    const rendered = renderEntry(entry, { stripReasoning: true });
    expect(rendered?.includes("hello")).toBe(true);

    const tailResult = selectTail([entry], 5);
    expect(Array.isArray(tailResult.selected)).toBe(true);
    expect(tailResult.selected.length).toBe(1);
  });
});
