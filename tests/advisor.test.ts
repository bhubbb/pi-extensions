import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TOOL_CALL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  buildTranscript,
  getAdvisorCompletions,
  parseSpec,
  renderEntry,
  resolveAdviseMode,
  truncate,
  validateAdvisorConfig,
} from "../packages/pi-advisor/advisor.js";

test("parseSpec accepts provider/id and rejects malformed specs", () => {
  assert.deepEqual(parseSpec("openai/gpt-5"), { provider: "openai", id: "gpt-5" });
  assert.deepEqual(parseSpec("provider/model/with/slashes"), { provider: "provider", id: "model/with/slashes" });
  assert.equal(parseSpec("noslash"), undefined);
  assert.equal(parseSpec("/missing-provider"), undefined);
  assert.equal(parseSpec("missing-id/"), undefined);
});

test("validateAdvisorConfig keeps valid keys and ignores invalid keys", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    assert.deepEqual(
      validateAdvisorConfig({
        model: "openai/gpt-5",
        thinking: "xhigh",
        onDone: true,
        whenStuck: 3,
        timeoutMs: 0,
      }),
      { model: "openai/gpt-5", thinking: "xhigh", onDone: true, whenStuck: 3, timeoutMs: 0 },
    );

    assert.deepEqual(
      validateAdvisorConfig({
        model: 42,
        thinking: "extreme",
        onDone: "yes",
        whenStuck: -1,
        timeoutMs: 1.5,
      }),
      {},
    );
    assert.ok(warnings.length >= 5);
  } finally {
    console.warn = originalWarn;
  }
});

test("truncate appends omitted character count", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdef", 3), "abc\n…[truncated 3 chars]");
});

test("renderEntry applies named truncation limits", () => {
  const longArg = "x".repeat(MAX_TOOL_CALL_ARGS_CHARS + 50);
  const assistant = renderEntry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: longArg } }],
    },
  });
  assert.match(assistant ?? "", /truncated/);

  const longResult = "y".repeat(MAX_TOOL_RESULT_CHARS + 10);
  const result = renderEntry({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: longResult }],
      isError: true,
    },
  });
  assert.match(result ?? "", /Result of `bash` \(error\)/);
  assert.match(result ?? "", /truncated 10 chars/);
});

test("buildTranscript drops oldest sections when context budget is exceeded", () => {
  const entries = ["one", "two", "three"].map((text) => ({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: text.repeat(5000) }] },
  }));

  const transcript = buildTranscript(entries, { contextWindow: 5000, maxTokens: 1000 });
  assert.match(transcript, /earlier section\(s\) truncated/);
  assert.doesNotMatch(transcript, /oneoneone/);
  assert.match(transcript, /threethree/);
});

test("advisor completions include subcommands and preserve earlier arguments for second-token completion", () => {
  const firstToken = getAdvisorCompletions("on") ?? [];
  assert.deepEqual(firstToken.find((item) => item.label === "on-done"), {
    value: "on-done",
    label: "on-done",
    description: "Toggle automatic review when the agent finishes",
  });

  const completions = getAdvisorCompletions("kapper-ai/Anthropic.claude-opus-4-8 xh") ?? [];
  assert.deepEqual(
    completions.find((item) => item.label === "xhigh"),
    {
      value: "kapper-ai/Anthropic.claude-opus-4-8 xhigh",
      label: "xhigh",
      description: "Maximum reasoning budget",
    },
  );

  const afterModelSpace = getAdvisorCompletions("kapper-ai/Anthropic.claude-opus-4-8 ") ?? [];
  assert.deepEqual(afterModelSpace.find((item) => item.label === "high"), {
    value: "kapper-ai/Anthropic.claude-opus-4-8 high",
    label: "high",
    description: "More reasoning for harder tasks",
  });

  const onDone = getAdvisorCompletions("on-done o") ?? [];
  assert.deepEqual(onDone.find((item) => item.label === "on"), { value: "on-done on", label: "on" });
});

test("resolveAdviseMode defaults to pipe when idle and steer when running", () => {
  assert.equal(resolveAdviseMode("", true), "pipe");
  assert.equal(resolveAdviseMode(undefined, false), "steer");
  assert.equal(resolveAdviseMode("show", false), "show");
  assert.equal(resolveAdviseMode(" pipe ", false), "pipe");
  assert.equal(resolveAdviseMode("bogus", true), undefined);
});
