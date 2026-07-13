/**
 * tests/config.test.mjs — tests for src/config.ts
 *
 * Tests:
 * 1. validateAdvisorConfig accepts valid keys, rejects invalid ones
 * 2. DEFAULTS fill correctly
 * 3. env override precedence
 * 4. git-* diff mode downgrade when untrusted
 * 5. Import/initialize the extension — makes sure the module doesn't explode
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_CWD = path.join(os.tmpdir(), `pi-advisor-test-${Date.now()}`);

describe("config.ts — validation", async function () {
  it("accepts valid existing keys", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({
      model: "openrouter/anthropic/claude-3.5-sonnet",
      thinking: "high",
      onDone: true,
      onTodoDone: true,
      whenStuck: 3,
      timeoutMs: 120000,
    });
    assert.equal(result.model, "openrouter/anthropic/claude-3.5-sonnet");
    assert.equal(result.thinking, "high");
    assert.equal(result.onDone, true);
    assert.equal(result.onTodoDone, true);
    assert.equal(result.whenStuck, 3);
    assert.equal(result.timeoutMs, 120000);
  });

  it("accepts valid new keys", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({
      contextMode: "summary+tail",
      tailMessages: 10,
      stripReasoning: true,
      keepToolResults: "recent",
      diffMode: "stat",
      diffMaxChars: 4000,
      summaryModel: "executor",
      summaryMaxTokens: 1024,
      summaryRefreshEvery: 8,
      summaryTimeoutMs: 60000,
    });
    assert.equal(result.contextMode, "summary+tail");
    assert.equal(result.tailMessages, 10);
    assert.equal(result.stripReasoning, true);
    assert.equal(result.keepToolResults, "recent");
    assert.equal(result.diffMode, "stat");
    assert.equal(result.diffMaxChars, 4000);
    assert.equal(result.summaryModel, "executor");
    assert.equal(result.summaryMaxTokens, 1024);
    assert.equal(result.summaryRefreshEvery, 8);
    assert.equal(result.summaryTimeoutMs, 60000);
  });

  it("rejects invalid contextMode", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ contextMode: "invalid-mode" });
    assert.equal(result.contextMode, undefined);
  });

  it("rejects invalid diffMode", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ diffMode: "git-raw" });
    assert.equal(result.diffMode, undefined);
  });

  it("rejects invalid summaryModel", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ summaryModel: ["provider/id"] });
    assert.equal(result.summaryModel, undefined);
  });

  it("accepts summaryModel as null", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ summaryModel: null });
    assert.equal(result.summaryModel, null);
  });

  it("rejects tailMessages < 2", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ tailMessages: 1 });
    assert.equal(result.tailMessages, undefined);
  });

  it("rejects diffMaxChars < 200", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ diffMaxChars: 100 });
    assert.equal(result.diffMaxChars, undefined);
  });

  it("rejects summaryMaxTokens < 256", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ summaryMaxTokens: 100 });
    assert.equal(result.summaryMaxTokens, undefined);
  });

  it("rejects negative values", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ whenStuck: -1, timeoutMs: -1, summaryTimeoutMs: -1 });
    assert.equal(result.whenStuck, undefined);
    assert.equal(result.timeoutMs, undefined);
    assert.equal(result.summaryTimeoutMs, undefined);
  });

  it("rejects non-integer values", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ tailMessages: 1.5, whenStuck: "3" });
    assert.equal(result.tailMessages, undefined);
    assert.equal(result.whenStuck, undefined);
  });
});

describe("config.ts — onTodoDone", async function () {
  it("accepts onTodoDone as boolean", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    assert.equal(validateAdvisorConfig({ onTodoDone: true }).onTodoDone, true);
    assert.equal(validateAdvisorConfig({ onTodoDone: false }).onTodoDone, false);
  });

  it("rejects onTodoDone as non-boolean", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    const result = validateAdvisorConfig({ onTodoDone: "yes" });
    assert.equal(result.onTodoDone, undefined);
  });

  it("resolves onTodoDone from project config", async () => {
    const { resolveEffectiveConfig, projectConfigPath } = await import("../src/config.mjs");
    const cwd = path.join(TEST_CWD, "onTodoDone-project");
    const projectFile = projectConfigPath(cwd);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({ onTodoDone: true }), "utf-8");
    try {
      const cfg = resolveEffectiveConfig(cwd, true);
      assert.equal(cfg.onTodoDone, true);
    } finally {
      fs.rmSync(path.dirname(path.dirname(projectFile)), { recursive: true, force: true });
    }
  });

  it("defaults onTodoDone to false", async () => {
    const { resolveEffectiveConfig } = await import("../src/config.mjs");
    const cfg = resolveEffectiveConfig(TEST_CWD, false);
    assert.equal(cfg.onTodoDone, false);
  });
});

describe("config.ts — defaults", async function () {
  it("DEFAULTS have correct values", async () => {
    const { DEFAULTS } = await import("../src/config.mjs");
    assert.equal(DEFAULTS.contextMode, "summary+tail");
    assert.equal(DEFAULTS.tailMessages, 10);
    assert.equal(DEFAULTS.stripReasoning, true);
    assert.equal(DEFAULTS.keepToolResults, "recent");
    assert.equal(DEFAULTS.diffMode, "stat");
    assert.equal(DEFAULTS.diffMaxChars, 4000);
    assert.equal(DEFAULTS.summaryModel, "executor");
    assert.equal(DEFAULTS.summaryMaxTokens, 1024);
    assert.equal(DEFAULTS.summaryRefreshEvery, 8);
    assert.equal(DEFAULTS.summaryTimeoutMs, 60000);
  });

  it("validateAdvisorConfig returns empty for invalid input", async () => {
    const { validateAdvisorConfig } = await import("../src/config.mjs");
    assert.deepEqual(validateAdvisorConfig(null), {});
    assert.deepEqual(validateAdvisorConfig([]), {});
    assert.deepEqual(validateAdvisorConfig("string"), {});
  });
});

describe("config.ts — normalization", async function () {
  it("downgrades git-stat to stat when untrusted", async () => {
    const { normalizeDiffMode } = await import("../src/config.mjs");
    const result = normalizeDiffMode("git-stat", false);
    assert.equal(result.effectiveMode, "stat");
    assert.ok(result.warning?.includes("downgraded"));
  });

  it("downgrades git-snippets to snippets when untrusted", async () => {
    const { normalizeDiffMode } = await import("../src/config.mjs");
    const result = normalizeDiffMode("git-snippets", false);
    assert.equal(result.effectiveMode, "snippets");
  });

  it("keeps git modes when trusted", async () => {
    const { normalizeDiffMode } = await import("../src/config.mjs");
    const result = normalizeDiffMode("git-stat", true);
    assert.equal(result.effectiveMode, "git-stat");
    assert.equal(result.warning, undefined);
  });

  it("keeps non-git modes unchanged", async () => {
    const { normalizeDiffMode } = await import("../src/config.mjs");
    assert.equal(normalizeDiffMode("stat", false).effectiveMode, "stat");
    assert.equal(normalizeDiffMode("stat", true).effectiveMode, "stat");
    assert.equal(normalizeDiffMode("none", false).effectiveMode, "none");
  });
});

describe("config.ts — import & initialization", async function () {
  it("module loads without throwing (no pi context required)", async () => {
    // This is the key test: the config module must be importable and usable
    // without a pi ExtensionContext. If it fails here, the whole extension
    // will crash on import.
    const {
      validateAdvisorConfig,
      DEFAULTS,
      normalizeDiffMode,
      globalConfigPath,
      projectConfigPath,
      resolveEffectiveConfig,
    } = await import("../src/config.mjs");

    assert.ok(typeof validateAdvisorConfig === "function");
    assert.ok(typeof DEFAULTS === "object");
    assert.ok(typeof normalizeDiffMode === "function");
    assert.ok(typeof globalConfigPath === "function");
    assert.ok(typeof projectConfigPath === "function");
    assert.ok(typeof resolveEffectiveConfig === "function");

    // Also verify resolveEffectiveConfig doesn't throw (it will use defaults
    // if no config files exist)
    const config = resolveEffectiveConfig(TEST_CWD, false);
    assert.ok(config);
    assert.equal(config.contextMode, "summary+tail");
  });
});
