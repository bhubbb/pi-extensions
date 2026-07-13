/**
 * tests/diff.test.mjs — tests for src/diff.ts
 *
 * Tests:
 * 1. countPatchChanges correctly counts + and - lines
 * 2. isVerificationCommand detects test/lint commands
 * 3. collectChangesFromEvents aggregates edits by path
 * 4. collectChangesFromBranch reconstructs from toolCall args
 * 5. renderDigest produces correct stat/snippets output
 * 6. Import/initialize the extension — makes sure the module doesn't explode
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// ── countPatchChanges ───────────────────────────────────────────────────────

describe("diff.ts — countPatchChanges", () => {
  it("counts added and removed lines in a unified patch", async () => {
    const { countPatchChanges } = await import("../src/diff.mjs");
    const patch = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 function hello() {
-  return "world";
+  return "hello world";
 }
+// added line`;
    const result = countPatchChanges(patch);
    assert.equal(result.added, 2);
    assert.equal(result.removed, 1);
  });

  it("skips +++ and --- headers", async () => {
    const { countPatchChanges } = await import("../src/diff.mjs");
    const patch = `--- a/file.ts
+++ b/file.ts`;
    const result = countPatchChanges(patch);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
  });

  it("handles empty patch", async () => {
    const { countPatchChanges } = await import("../src/diff.mjs");
    const result = countPatchChanges("");
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
  });

  it("handles patch with no changes", async () => {
    const { countPatchChanges } = await import("../src/diff.mjs");
    const result = countPatchChanges("context line\nanother context");
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
  });

  it("only counts lines starting with + or -", async () => {
    const { countPatchChanges } = await import("../src/diff.mjs");
    const patch = `@@ -1 +1 @@
-old
+new
 context`;
    const result = countPatchChanges(patch);
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
  });
});

// ── isVerificationCommand ──────────────────────────────────────────────────

describe("diff.ts — isVerificationCommand", () => {
  it("detects test commands", async () => {
    const { isVerificationCommand } = await import("../src/diff.mjs");
    assert.ok(isVerificationCommand("npm test"));
    assert.ok(isVerificationCommand("npx jest"));
    assert.ok(isVerificationCommand("bun test"));
    assert.ok(isVerificationCommand("cargo test"));
    assert.ok(isVerificationCommand("go test"));
    assert.ok(isVerificationCommand("python3 -m pytest"));
    assert.ok(isVerificationCommand("make test"));
  });

  it("detects lint/build commands", async () => {
    const { isVerificationCommand } = await import("../src/diff.mjs");
    assert.ok(isVerificationCommand("npm run lint"));
    assert.ok(isVerificationCommand("npm run typecheck"));
    assert.ok(isVerificationCommand("cargo clippy"));
    assert.ok(isVerificationCommand("go vet"));
    assert.ok(isVerificationCommand("make build"));
  });

  it("detects multi-segment pipelines", async () => {
    const { isVerificationCommand } = await import("../src/diff.mjs");
    assert.ok(isVerificationCommand("npm run lint && npm test"));
    assert.ok(isVerificationCommand("tsc && node --test"));
  });

  it("rejects non-verification commands", async () => {
    const { isVerificationCommand } = await import("../src/diff.mjs");
    assert.equal(isVerificationCommand("cat tests/foo.test.ts"), false);
    assert.equal(isVerificationCommand("echo hello"), false);
    assert.equal(isVerificationCommand("ls -la"), false);
    assert.equal(isVerificationCommand(undefined), false);
    assert.equal(isVerificationCommand(""), false);
  });
});

// ── collectChangesFromEvents ────────────────────────────────────────────────

describe("diff.ts — collectChangesFromEvents", () => {
  it("aggregates edits by path with correct +/- counts", async () => {
    const { collectChangesFromEvents, countPatchChanges } = await import("../src/diff.mjs");
    const events = [
      {
        kind: "edit",
        path: "src/foo.ts",
        patch: `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new`,
        isError: false,
        ts: Date.now(),
      },
    ];
    const changes = collectChangesFromEvents(events, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/foo.ts");
    assert.equal(changes[0].added, 1);
    assert.equal(changes[0].removed, 1);
  });

  it("skips no-op edits (empty patch)", async () => {
    const { collectChangesFromEvents } = await import("../src/diff.mjs");
    const events = [
      { kind: "edit", path: "src/foo.ts", patch: "", isError: false, ts: Date.now() },
    ];
    const changes = collectChangesFromEvents(events, "stat", 4000);
    assert.equal(changes.length, 0);
  });

  it("handles write events", async () => {
    const { collectChangesFromEvents } = await import("../src/diff.mjs");
    const events = [
      {
        kind: "write",
        path: "README.md",
        content: "Line 1\nLine 2\nLine 3",
        isError: false,
        ts: Date.now(),
      },
    ];
    const changes = collectChangesFromEvents(events, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "README.md");
    assert.equal(changes[0].writtenLines, 3);
  });

  it("aggregates multiple edits for same path", async () => {
    const { collectChangesFromEvents } = await import("../src/diff.mjs");
    const events = [
      {
        kind: "edit",
        path: "src/foo.ts",
        patch: `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old1\n+new1`,
        isError: false,
        ts: Date.now(),
      },
      {
        kind: "edit",
        path: "src/foo.ts",
        patch: `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -2 +2 @@\n-old2\n+new2\n+added`,
        isError: false,
        ts: Date.now(),
      },
    ];
    const changes = collectChangesFromEvents(events, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/foo.ts");
    assert.equal(changes[0].added, 2); // 1 + 1
    assert.equal(changes[0].removed, 2); // 1 + 1
  });

  it("sorts changes by path", async () => {
    const { collectChangesFromEvents } = await import("../src/diff.mjs");
    const events = [
      { kind: "edit", path: "src/z.ts", patch: "--- a/src/z.ts\n+++ b/src/z.ts\n@@ -1 +1 @@\n-a\n+b", isError: false, ts: Date.now() },
      { kind: "edit", path: "src/a.ts", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-c\n+d", isError: false, ts: Date.now() },
    ];
    const changes = collectChangesFromEvents(events, "stat", 4000);
    assert.equal(changes[0].path, "src/a.ts");
    assert.equal(changes[1].path, "src/z.ts");
  });
});

// ── collectChangesFromBranch ────────────────────────────────────────────────

describe("diff.ts — collectChangesFromBranch", () => {
  it("reconstructs edit changes from toolCall args", async () => {
    const { collectChangesFromBranch } = await import("../src/diff.mjs");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: {
                path: "src/foo.ts",
                edits: [
                  { oldText: "old line", newText: "new line" },
                ],
              },
            },
          ],
        },
      },
    ];
    const changes = collectChangesFromBranch(entries, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "src/foo.ts");
    assert.equal(changes[0].added, 1);
    assert.equal(changes[0].removed, 1);
  });

  it("handles legacy edit args (oldText/newText at top level)", async () => {
    const { collectChangesFromBranch } = await import("../src/diff.mjs");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: {
                path: "src/bar.ts",
                oldText: "legacy old",
                newText: "legacy new",
              },
            },
          ],
        },
      },
    ];
    const changes = collectChangesFromBranch(entries, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].added, 1);
    assert.equal(changes[0].removed, 1);
  });

  it("handles write args", async () => {
    const { collectChangesFromBranch } = await import("../src/diff.mjs");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "write",
              arguments: {
                path: "new-file.ts",
                content: "line1\nline2\nline3\nline4\nline5",
              },
            },
          ],
        },
      },
    ];
    const changes = collectChangesFromBranch(entries, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "new-file.ts");
    assert.equal(changes[0].writtenLines, 5);
  });

  it("returns empty for non-toolCall entries", async () => {
    const { collectChangesFromBranch } = await import("../src/diff.mjs");
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ];
    const changes = collectChangesFromBranch(entries, "stat", 4000);
    assert.equal(changes.length, 0);
  });

  it("aggregates multiple edits for same path", async () => {
    const { collectChangesFromBranch } = await import("../src/diff.mjs");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: {
                path: "src/foo.ts",
                edits: [
                  { oldText: "line1", newText: "line1-new" },
                ],
              },
            },
            {
              type: "toolCall",
              name: "edit",
              arguments: {
                path: "src/foo.ts",
                edits: [
                  { oldText: "line2", newText: "line2-new" },
                ],
              },
            },
          ],
        },
      },
    ];
    const changes = collectChangesFromBranch(entries, "stat", 4000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].added, 2);
    assert.equal(changes[0].removed, 2);
  });
});

// ── renderDigest ────────────────────────────────────────────────────────────

describe("diff.ts — renderDigest", () => {
  it("renders stat digest", async () => {
    const { renderDigest } = await import("../src/diff.mjs");
    const changes = [
      { path: "src/foo.ts", added: 12, removed: 3 },
      { path: "README.md", added: 84, removed: 0, writtenLines: 84 },
    ];
    const digest = renderDigest(changes, [], "stat", 4000);
    assert.ok(digest.includes("Changed files:"));
    assert.ok(digest.includes("src/foo.ts"));
    assert.ok(digest.includes("+12 /-3"));
    assert.ok(digest.includes("README.md"));
    assert.ok(digest.includes("rewritten, 84 lines"));
  });

  it("renders stat digest with verification commands", async () => {
    const { renderDigest } = await import("../src/diff.mjs");
    const changes = [{ path: "src/foo.ts", added: 1, removed: 1 }];
    const digest = renderDigest(changes, ["npm test", "cargo clippy"], "stat", 4000);
    assert.ok(digest.includes("Verification run:"));
    assert.ok(digest.includes("npm test"));
  });

  it("renders snippets digest with capped content", async () => {
    const { renderDigest } = await import("../src/diff.mjs");
    const changes = [
      {
        path: "src/foo.ts",
        added: 5,
        removed: 2,
        snippet: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
      },
    ];
    const digest = renderDigest(changes, [], "snippets", 4000);
    assert.ok(digest.includes("Changed files:"));
    assert.ok(digest.includes("src/foo.ts"));
    assert.ok(digest.includes("--- src/foo.ts"));
    assert.ok(digest.includes("line1"));
  });

  it("truncates digest at maxChars", async () => {
    const { renderDigest } = await import("../src/diff.mjs");
    const changes = [
      {
        path: "src/foo.ts",
        added: 5,
        removed: 2,
        snippet: "a".repeat(5000), // very long snippet
      },
    ];
    const digest = renderDigest(changes, [], "snippets", 100);
    assert.ok(digest.length <= 100 + 15); // allow for "[digest truncated]" suffix
  });

  it("returns empty string for diffMode 'none'", async () => {
    const { renderDigest } = await import("../src/diff.mjs");
    const digest = renderDigest([], [], "none", 4000);
    assert.equal(digest, "");
  });
});

// ── Import & initialization ─────────────────────────────────────────────────

describe("diff.ts — import & initialization", () => {
  it("module loads without throwing (no pi context required)", async () => {
    const {
      countPatchChanges,
      isVerificationCommand,
      collectChangesFromEvents,
      collectChangesFromBranch,
      renderDigest,
    } = await import("../src/diff.mjs");

    assert.ok(typeof countPatchChanges === "function");
    assert.ok(typeof isVerificationCommand === "function");
    assert.ok(typeof collectChangesFromEvents === "function");
    assert.ok(typeof collectChangesFromBranch === "function");
    assert.ok(typeof renderDigest === "function");

    // Quick smoke test to verify functions are callable
    const changes = collectChangesFromEvents([], "stat", 4000);
    assert.ok(Array.isArray(changes));
    assert.equal(changes.length, 0);
  });
});
