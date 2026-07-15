/**
 * tests/config.test.ts — tests for src/config.ts
 *
 * Tests:
 * 1. validateAdvisorConfig accepts valid keys, rejects invalid ones
 * 2. DEFAULTS fill correctly
 * 3. env override precedence
 * 4. git-* diff mode downgrade when untrusted
 * 5. Import/initialize the extension — makes sure the module doesn't explode
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_CWD = path.join(os.tmpdir(), `pi-advisor-test-${Date.now()}`);

describe("config.ts — validation", () => {
  it("accepts valid existing keys", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({
      model: "openrouter/anthropic/claude-3.5-sonnet",
      thinking: "high",
      onDone: true,
      onTodoDone: true,
      whenStuck: 3,
      timeoutMs: 120000,
    });
    expect(result.model).toBe("openrouter/anthropic/claude-3.5-sonnet");
    expect(result.thinking).toBe("high");
    expect(result.onDone).toBe(true);
    expect(result.onTodoDone).toBe(true);
    expect(result.whenStuck).toBe(3);
    expect(result.timeoutMs).toBe(120000);
  });

  it("accepts valid new keys", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
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
    expect(result.contextMode).toBe("summary+tail");
    expect(result.tailMessages).toBe(10);
    expect(result.stripReasoning).toBe(true);
    expect(result.keepToolResults).toBe("recent");
    expect(result.diffMode).toBe("stat");
    expect(result.diffMaxChars).toBe(4000);
    expect(result.summaryModel).toBe("executor");
    expect(result.summaryMaxTokens).toBe(1024);
    expect(result.summaryRefreshEvery).toBe(8);
    expect(result.summaryTimeoutMs).toBe(60000);
  });

  it("rejects invalid contextMode", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ contextMode: "invalid-mode" });
    expect(result.contextMode).toBeUndefined();
  });

  it("rejects invalid diffMode", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ diffMode: "git-raw" });
    expect(result.diffMode).toBeUndefined();
  });

  it("rejects invalid summaryModel", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ summaryModel: ["provider/id"] });
    expect(result.summaryModel).toBeUndefined();
  });

  it("accepts summaryModel as null", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ summaryModel: null });
    expect(result.summaryModel).toBeNull();
  });

  it("rejects tailMessages < 2", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ tailMessages: 1 });
    expect(result.tailMessages).toBeUndefined();
  });

  it("rejects diffMaxChars < 200", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ diffMaxChars: 100 });
    expect(result.diffMaxChars).toBeUndefined();
  });

  it("rejects summaryMaxTokens < 256", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ summaryMaxTokens: 100 });
    expect(result.summaryMaxTokens).toBeUndefined();
  });

  it("rejects negative values", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ whenStuck: -1, timeoutMs: -1, summaryTimeoutMs: -1 });
    expect(result.whenStuck).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
    expect(result.summaryTimeoutMs).toBeUndefined();
  });

  it("rejects non-integer values", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ tailMessages: 1.5, whenStuck: "3" });
    expect(result.tailMessages).toBeUndefined();
    expect(result.whenStuck).toBeUndefined();
  });
});

describe("config.ts — onTodoDone", () => {
  it("accepts onTodoDone as boolean", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    expect(validateAdvisorConfig({ onTodoDone: true }).onTodoDone).toBe(true);
    expect(validateAdvisorConfig({ onTodoDone: false }).onTodoDone).toBe(false);
  });

  it("rejects onTodoDone as non-boolean", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    const result = validateAdvisorConfig({ onTodoDone: "yes" });
    expect(result.onTodoDone).toBeUndefined();
  });

  it("resolves onTodoDone from project config", async () => {
    const { resolveEffectiveConfig, projectConfigPath } = await import("../src/config");
    const cwd = path.join(TEST_CWD, "onTodoDone-project");
    const projectFile = projectConfigPath(cwd);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({ onTodoDone: true }), "utf-8");
    try {
      const cfg = resolveEffectiveConfig(cwd, true);
      expect(cfg.onTodoDone).toBe(true);
    } finally {
      fs.rmSync(path.dirname(path.dirname(projectFile)), { recursive: true, force: true });
    }
  });

  it("defaults onTodoDone to false", async () => {
    // Provide an empty global config so onTodoDone falls through to the default.
    // Hermetic: use a temp dir with HOME override, never touch real ~/.pi/.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { resolveEffectiveConfig, globalConfigPath } = await import("../src/config");
    // Create temp dir and override HOME so globalConfigPath() resolves inside it
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-advisor-gc-"));
    const origHome = process.env.HOME;
    process.env.HOME = globalDir;
    try {
      // globalConfigPath() now returns <temp>/.pi/agent/advisor.json
      // Write empty JSON so validateAdvisorConfig returns {}
      fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
      fs.writeFileSync(globalConfigPath(), "{}", "utf-8");
      const cfg = resolveEffectiveConfig(TEST_CWD, false);
      expect(cfg.onTodoDone).toBe(false);
    } finally {
      // Restore HOME first (critical: globalConfigPath depends on os.homedir())
      process.env.HOME = origHome;
      // Then clean up the entire temp dir
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

describe("config.ts — defaults", () => {
  it("DEFAULTS have correct values", async () => {
    const { DEFAULTS } = await import("../src/config");
    expect(DEFAULTS.contextMode).toBe("summary+tail");
    expect(DEFAULTS.tailMessages).toBe(10);
    expect(DEFAULTS.stripReasoning).toBe(true);
    expect(DEFAULTS.keepToolResults).toBe("recent");
    expect(DEFAULTS.diffMode).toBe("stat");
    expect(DEFAULTS.diffMaxChars).toBe(4000);
    expect(DEFAULTS.summaryModel).toBe("executor");
    expect(DEFAULTS.summaryMaxTokens).toBe(1024);
    expect(DEFAULTS.summaryRefreshEvery).toBe(8);
    expect(DEFAULTS.summaryTimeoutMs).toBe(60000);
  });

  it("validateAdvisorConfig returns empty for invalid input", async () => {
    const { validateAdvisorConfig } = await import("../src/config");
    expect(validateAdvisorConfig(null)).toEqual({});
    expect(validateAdvisorConfig([])).toEqual({});
    expect(validateAdvisorConfig("string")).toEqual({});
  });
});

describe("config.ts — normalization", () => {
  it("downgrades git-stat to stat when untrusted", async () => {
    const { normalizeDiffMode } = await import("../src/config");
    const result = normalizeDiffMode("git-stat", false);
    expect(result.effectiveMode).toBe("stat");
    expect(result.warning).toContain("downgraded");
  });

  it("downgrades git-snippets to snippets when untrusted", async () => {
    const { normalizeDiffMode } = await import("../src/config");
    const result = normalizeDiffMode("git-snippets", false);
    expect(result.effectiveMode).toBe("snippets");
  });

  it("keeps git modes when trusted", async () => {
    const { normalizeDiffMode } = await import("../src/config");
    const result = normalizeDiffMode("git-stat", true);
    expect(result.effectiveMode).toBe("git-stat");
    expect(result.warning).toBeUndefined();
  });

  it("keeps non-git modes unchanged", async () => {
    const { normalizeDiffMode } = await import("../src/config");
    expect(normalizeDiffMode("stat", false).effectiveMode).toBe("stat");
    expect(normalizeDiffMode("stat", true).effectiveMode).toBe("stat");
    expect(normalizeDiffMode("none", false).effectiveMode).toBe("none");
  });
});

describe("config.ts — import & initialization", () => {
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
    } = await import("../src/config");

    expect(typeof validateAdvisorConfig).toBe("function");
    expect(typeof DEFAULTS).toBe("object");
    expect(typeof normalizeDiffMode).toBe("function");
    expect(typeof globalConfigPath).toBe("function");
    expect(typeof projectConfigPath).toBe("function");
    expect(typeof resolveEffectiveConfig).toBe("function");

    // Also verify resolveEffectiveConfig doesn't throw (it will use defaults
    // if no config files exist)
    const config = resolveEffectiveConfig(TEST_CWD, false);
    expect(config).toBeDefined();
    expect(config.contextMode).toBe("summary+tail");
  });
});
