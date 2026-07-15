/**
 * tests/policy-subcommands.test.ts — tests for policy subcommand validators.
 *
 * Tests the pure parse* functions in src/config.ts. No pi context, no real
 * filesystem access, no user config files touched. Uses bun:test.
 *
 * Coverage: positive (valid → patch), negative (invalid → error), boundary
 * (off → null). Also verifies round-trip through validateAdvisorConfig.
 */

import { describe, it, expect } from "bun:test";

// Dynamic import avoids loading the full pi extension (which needs pi internals).
const {
  parseContextMode,
  parseTailMessages,
  parseDiffMode,
  parseStripReasoning,
  parseSummaryModel,
  validateAdvisorConfig,
} = await import("../src/config");

// ── parseContextMode ────────────────────────────────────────────────────────

describe("parseContextMode", () => {
  it("accepts all valid modes", () => {
    for (const mode of ["full", "tail", "summary", "summary+tail"]) {
      const r = parseContextMode(mode);
      expect(r.ok).toBe(true);
      expect(r).toEqual({ ok: true, patch: { contextMode: mode } });
    }
  });

  it("rejects missing arg", () => {
    const r = parseContextMode(undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Usage");
  });

  it("rejects invalid mode", () => {
    expect(parseContextMode("bogus").ok).toBe(false);
  });
});

// ── parseTailMessages ───────────────────────────────────────────────────────

describe("parseTailMessages", () => {
  it("accepts valid integers >= 2", () => {
    for (const n of ["2", "5", "10", "100"]) {
      const r = parseTailMessages(n);
      expect(r.ok).toBe(true);
      expect(r).toEqual({ ok: true, patch: { tailMessages: Number(n) } });
    }
  });

  it("rejects values below 2", () => {
    expect(parseTailMessages("0").ok).toBe(false);
    expect(parseTailMessages("1").ok).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(parseTailMessages("abc").ok).toBe(false);
    expect(parseTailMessages("1.5").ok).toBe(false);
    expect(parseTailMessages("").ok).toBe(false);
  });

  it("rejects missing arg", () => {
    expect(parseTailMessages(undefined).ok).toBe(false);
  });
});

// ── parseDiffMode ────────────────────────────────────────────────────────────

describe("parseDiffMode", () => {
  it("accepts all valid diff modes", () => {
    for (const mode of ["none", "stat", "snippets", "git-stat", "git-snippets"]) {
      const r = parseDiffMode(mode);
      expect(r.ok).toBe(true);
      expect(r).toEqual({ ok: true, patch: { diffMode: mode } });
    }
  });

  it("rejects invalid mode", () => {
    expect(parseDiffMode("invalid").ok).toBe(false);
  });

  it("rejects missing arg", () => {
    expect(parseDiffMode(undefined).ok).toBe(false);
  });
});

// ── parseStripReasoning ──────────────────────────────────────────────────────

describe("parseStripReasoning", () => {
  it("'on' → stripReasoning: true", () => {
    const r = parseStripReasoning("on");
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, patch: { stripReasoning: true } });
  });

  it("'off' → stripReasoning: false", () => {
    const r = parseStripReasoning("off");
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, patch: { stripReasoning: false } });
  });

  it("rejects anything other than on/off", () => {
    for (const v of ["true", "false", "yes", "no", ""]) {
      expect(parseStripReasoning(v).ok).toBe(false);
    }
  });

  it("rejects missing arg", () => {
    expect(parseStripReasoning(undefined).ok).toBe(false);
  });
});

// ── parseSummaryModel ───────────────────────────────────────────────────────

describe("parseSummaryModel", () => {
  // Minimal registry mock: returns true for known specs.
  const KNOWN = new Set([
    "anthropic/claude-haiku-4-5",
    "openai/gpt-4.1-mini",
  ]);
  const findModel = (provider: string, id: string) => KNOWN.has(`${provider}/${id}`);

  it("'executor' → summaryModel: 'executor'", () => {
    const r = parseSummaryModel("executor", findModel);
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, patch: { summaryModel: "executor" } });
  });

  it("'off' → summaryModel: null (boundary: off → null transition)", () => {
    const r = parseSummaryModel("off", findModel);
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, patch: { summaryModel: null } });
  });

  it("accepts a registered provider/id spec", () => {
    const r = parseSummaryModel("anthropic/claude-haiku-4-5", findModel);
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, patch: { summaryModel: "anthropic/claude-haiku-4-5" } });
  });

  it("rejects an unregistered provider/id spec", () => {
    const r = parseSummaryModel("unknown/bogus-model", findModel);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not in registry");
  });

  it("rejects a bare string with no slash (e.g. 'summary-model')", () => {
    expect(parseSummaryModel("summary-model", findModel).ok).toBe(false);
  });

  it("rejects edge-case specs", () => {
    expect(parseSummaryModel("/id", findModel).ok).toBe(false);
    expect(parseSummaryModel("provider/", findModel).ok).toBe(false);
    expect(parseSummaryModel("", findModel).ok).toBe(false);
  });

  it("rejects missing arg", () => {
    expect(parseSummaryModel(undefined, findModel).ok).toBe(false);
  });
});

// ── Round-trip through validateAdvisorConfig ─────────────────────────────────
// Verify every patch produced by the validators survives validation cleanly.
// This guarantees the config writer will not reject or corrupt the output.

describe("round-trip through validateAdvisorConfig", () => {
  it("contextMode round-trips", () => {
    const patch = parseContextMode("summary")!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.contextMode).toBe("summary");
  });

  it("summaryModel null (off) round-trips as null", () => {
    const patch = parseSummaryModel("off", () => false)!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.summaryModel).toBeNull();
  });

  it("summaryModel 'executor' round-trips", () => {
    const patch = parseSummaryModel("executor", () => false)!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.summaryModel).toBe("executor");
  });

  it("summaryModel provider/id round-trips", () => {
    const KNOWN = new Set(["anthropic/claude-haiku-4-5", "openai/gpt-4.1-mini"]);
    const findModel = (provider: string, id: string) => KNOWN.has(`${provider}/${id}`);
    const patch = parseSummaryModel("anthropic/claude-haiku-4-5", findModel)!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.summaryModel).toBe("anthropic/claude-haiku-4-5");
  });

  it("stripReasoning false round-trips", () => {
    const patch = parseStripReasoning("off")!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.stripReasoning).toBe(false);
  });

  it("tailMessages round-trips", () => {
    const patch = parseTailMessages("8")!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.tailMessages).toBe(8);
  });

  it("diffMode round-trips", () => {
    const patch = parseDiffMode("snippets")!.patch!;
    const result = validateAdvisorConfig(patch);
    expect(result.diffMode).toBe("snippets");
  });
});

// ── Integration: writeConfig → resolveEffectiveConfig round-trip ──────────────
// Exercises the full persistence pipeline: validator output → writeConfig →
// temp file → resolveEffectiveConfig → verify the value survived to disk.
// Hermetic: uses temp directories, never touches real user config files.

describe("integration: writeConfig → resolveEffectiveConfig round-trip", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const { writeConfig, resolveEffectiveConfig, projectConfigPath, globalConfigPath } = await import("../src/config");

  function makeCwd() {
    const d = path.join(os.tmpdir(), `pi-advisor-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it("summary-model off → null persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseSummaryModel("off", () => false)!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.summaryModel).toBeNull();
  });

  it("summary-model executor persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseSummaryModel("executor", () => false)!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.summaryModel).toBe("executor");
  });

  it("context mode persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseContextMode("summary+tail")!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.contextMode).toBe("summary+tail");
  });

  it("tail messages persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseTailMessages("6")!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.tailMessages).toBe(6);
  });

  it("diff mode persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseDiffMode("snippets")!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.diffMode).toBe("snippets");
  });

  it("strip-reasoning off persists and resolves", () => {
    const cwd = makeCwd();
    const patch = parseStripReasoning("off")!.patch!;
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    expect(resolved.stripReasoning).toBe(false);
  });

  it("invalid validator output never reaches writeConfig", () => {
    // Negative: the validator rejects invalid input, so no patch is produced
    // and writeConfig is never called — verified by the ok:false result.
    const r = parseTailMessages("1");
    expect(r.ok).toBe(false);
    expect(r.patch).toBeUndefined();
  });

  it("project-level null overrides global-level non-null (precedence)", () => {
    // Regression test for the ?? bug: project summaryModel: null must NOT
    // fall through to a global config that has a non-null value.
    // Hermetic: write "global" config to a temp dir sibling, not ~/.pi/.
    const cwd = makeCwd();
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-advisor-global-"));
    // Temporarily override HOME so globalConfigPath() resolves to our temp dir
    const origHome = process.env.HOME;
    process.env.HOME = globalDir;
    try {
      // Write a "global" config with a non-null summaryModel
      writeConfig(globalConfigPath(), { summaryModel: "executor" });
      // Write a project config with summaryModel: null (off)
      writeConfig(projectConfigPath(cwd), { summaryModel: null });
      // Re-resolve — this will read from our temp "global" path
      const resolved = resolveEffectiveConfig(cwd);
      // Project-level null must win over global "executor"
      expect(resolved.summaryModel).toBeNull();
    } finally {
      // Restore HOME and clean up temp dirs
      process.env.HOME = origHome;
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
