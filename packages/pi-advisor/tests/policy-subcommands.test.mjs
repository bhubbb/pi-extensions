/**
 * tests/policy-subcommands.test.mjs — hermetic tests for policy subcommand validators.
 *
 * Tests the pure parse* functions in src/config.ts. No pi context, no real
 * filesystem access, no user config files touched. Uses only node:test + node:assert.
 *
 * Coverage: positive (valid → patch), negative (invalid → error), boundary (off → null).
 * Also verifies round-trip through validateAdvisorConfig so disk writes are safe.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Dynamic import avoids loading the full pi extension (which needs pi internals).
const {
  parseContextMode,
  parseTailMessages,
  parseDiffMode,
  parseStripReasoning,
  parseSummaryModel,
  validateAdvisorConfig,
  writeConfig,
  resolveEffectiveConfig,
  projectConfigPath,
  globalConfigPath,
} = await import("../src/config.mjs");

// ── parseContextMode ────────────────────────────────────────────────────────

describe("parseContextMode", () => {
  it("accepts all valid modes", () => {
    for (const mode of ["full", "tail", "summary", "summary+tail"]) {
      const r = parseContextMode(mode);
      assert.ok(r.ok, `${mode} should be valid`);
      assert.deepStrictEqual(r.patch, { contextMode: mode });
    }
  });

  it("rejects missing arg", () => {
    const r = parseContextMode(undefined);
    assert.ok(!r.ok);
    assert.ok(r.error.includes("Usage"));
  });

  it("rejects invalid mode", () => {
    assert.ok(!parseContextMode("bogus").ok);
  });
});

// ── parseTailMessages ───────────────────────────────────────────────────────

describe("parseTailMessages", () => {
  it("accepts valid integers >= 2", () => {
    for (const n of ["2", "5", "10", "100"]) {
      const r = parseTailMessages(n);
      assert.ok(r.ok, `${n} should be valid`);
      assert.deepStrictEqual(r.patch, { tailMessages: Number(n) });
    }
  });

  it("rejects values below 2", () => {
    assert.ok(!parseTailMessages("0").ok);
    assert.ok(!parseTailMessages("1").ok);
  });

  it("rejects non-numeric input", () => {
    assert.ok(!parseTailMessages("abc").ok);
    assert.ok(!parseTailMessages("1.5").ok);
    assert.ok(!parseTailMessages("").ok);
  });

  it("rejects missing arg", () => {
    assert.ok(!parseTailMessages(undefined).ok);
  });
});

// ── parseDiffMode ────────────────────────────────────────────────────────────

describe("parseDiffMode", () => {
  it("accepts all valid diff modes", () => {
    for (const mode of ["none", "stat", "snippets", "git-stat", "git-snippets"]) {
      const r = parseDiffMode(mode);
      assert.ok(r.ok, `${mode} should be valid`);
      assert.deepStrictEqual(r.patch, { diffMode: mode });
    }
  });

  it("rejects invalid mode", () => {
    assert.ok(!parseDiffMode("invalid").ok);
  });

  it("rejects missing arg", () => {
    assert.ok(!parseDiffMode(undefined).ok);
  });
});

// ── parseStripReasoning ──────────────────────────────────────────────────────

describe("parseStripReasoning", () => {
  it("'on' → stripReasoning: true", () => {
    const r = parseStripReasoning("on");
    assert.ok(r.ok);
    assert.deepStrictEqual(r.patch, { stripReasoning: true });
  });

  it("'off' → stripReasoning: false", () => {
    const r = parseStripReasoning("off");
    assert.ok(r.ok);
    assert.deepStrictEqual(r.patch, { stripReasoning: false });
  });

  it("rejects anything other than on/off", () => {
    for (const v of ["true", "false", "yes", "no", ""]) {
      assert.ok(!parseStripReasoning(v).ok, `"${v}" should be rejected`);
    }
  });

  it("rejects missing arg", () => {
    assert.ok(!parseStripReasoning(undefined).ok);
  });
});

// ── parseSummaryModel ───────────────────────────────────────────────────────

describe("parseSummaryModel", () => {
  // Minimal registry mock: returns true for known specs.
  const KNOWN = new Set([
    "anthropic/claude-haiku-4-5",
    "openai/gpt-4.1-mini",
  ]);
  const findModel = (provider, id) => KNOWN.has(`${provider}/${id}`);

  it("'executor' → summaryModel: 'executor'", () => {
    const r = parseSummaryModel("executor", findModel);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.patch, { summaryModel: "executor" });
  });

  it("'off' → summaryModel: null (boundary: off → null transition)", () => {
    const r = parseSummaryModel("off", findModel);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.patch, { summaryModel: null });
  });

  it("accepts a registered provider/id spec", () => {
    const r = parseSummaryModel("anthropic/claude-haiku-4-5", findModel);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.patch, { summaryModel: "anthropic/claude-haiku-4-5" });
  });

  it("rejects an unregistered provider/id spec", () => {
    const r = parseSummaryModel("unknown/bogus-model", findModel);
    assert.ok(!r.ok);
    assert.ok(r.error.includes("not in registry"));
  });

  it("rejects a bare string with no slash (e.g. 'summary-model')", () => {
    assert.ok(!parseSummaryModel("summary-model", findModel).ok);
  });

  it("rejects edge-case specs", () => {
    assert.ok(!parseSummaryModel("/id", findModel).ok);
    assert.ok(!parseSummaryModel("provider/", findModel).ok);
    assert.ok(!parseSummaryModel("", findModel).ok);
  });

  it("rejects missing arg", () => {
    assert.ok(!parseSummaryModel(undefined, findModel).ok);
  });
});

// ── Round-trip through validateAdvisorConfig ─────────────────────────────────
// Verify every patch produced by the validators survives validation cleanly.
// This guarantees the config writer will not reject or corrupt the output.

describe("round-trip through validateAdvisorConfig", () => {
  const findModel = () => true; // not used for round-trip (patch already resolved)

  it("contextMode round-trips", () => {
    const { patch } = parseContextMode("summary");
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.contextMode, "summary");
  });

  it("summaryModel null (off) round-trips as null", () => {
    const { patch } = parseSummaryModel("off", findModel);
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.summaryModel, null);
  });

  it("summaryModel 'executor' round-trips", () => {
    const { patch } = parseSummaryModel("executor", findModel);
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.summaryModel, "executor");
  });

  it("summaryModel provider/id round-trips", () => {
    const { patch } = parseSummaryModel("anthropic/claude-haiku-4-5", findModel);
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.summaryModel, "anthropic/claude-haiku-4-5");
  });

  it("stripReasoning false round-trips", () => {
    const { patch } = parseStripReasoning("off");
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.stripReasoning, false);
  });

  it("tailMessages round-trips", () => {
    const { patch } = parseTailMessages("8");
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.tailMessages, 8);
  });

  it("diffMode round-trips", () => {
    const { patch } = parseDiffMode("snippets");
    const result = validateAdvisorConfig(patch);
    assert.strictEqual(result.diffMode, "snippets");
  });
});

// ── Integration: writeConfig → resolveEffectiveConfig round-trip ──────────────
// Exercises the full persistence pipeline: validator output → writeConfig →
// temp file → resolveEffectiveConfig → verify the value survived to disk.
// Hermetic: uses a temp directory, never touches real user config files.

describe("integration: writeConfig → resolveEffectiveConfig round-trip", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  function makeCwd() {
    const d = path.join(os.tmpdir(), `pi-advisor-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it("summary-model off → null persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseSummaryModel("off", () => false);
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.summaryModel, null);
  });

  it("summary-model executor persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseSummaryModel("executor", () => false);
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.summaryModel, "executor");
  });

  it("context mode persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseContextMode("summary+tail");
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.contextMode, "summary+tail");
  });

  it("tail messages persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseTailMessages("6");
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.tailMessages, 6);
  });

  it("diff mode persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseDiffMode("snippets");
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.diffMode, "snippets");
  });

  it("strip-reasoning off persists and resolves", () => {
    const cwd = makeCwd();
    const { patch } = parseStripReasoning("off");
    writeConfig(projectConfigPath(cwd), patch);
    const resolved = resolveEffectiveConfig(cwd);
    assert.strictEqual(resolved.stripReasoning, false);
  });

  it("invalid validator output never reaches writeConfig", () => {
    // Negative: the validator rejects invalid input, so no patch is produced
    // and writeConfig is never called — verified by the ok:false result.
    const r = parseTailMessages("1");
    assert.ok(!r.ok, "validator should reject tail < 2");
    assert.ok(!r.patch, "no patch should be produced for invalid input");
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
      assert.strictEqual(resolved.summaryModel, null, "project null must override global executor");
    } finally {
      // Restore HOME and clean up temp dirs
      process.env.HOME = origHome;
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
