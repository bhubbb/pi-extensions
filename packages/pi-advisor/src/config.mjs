/**
 * src/config.mjs — extended advisor configuration types, validation, and
 * resolution.  Pure module (Node builtins only) so it is unit-testable with
 * `node --test`.
 *
 * Extends the upstream `@hk_net/pi-advisor` config schema with context-policy
 * keys (contextMode, tailMessages, stripReasoning, etc.).
 *
 * All new keys are optional.  When absent the defaults defined below apply
 * (summary+tail mode by default, reasoning stripped).  Set contextMode to
 * "full" + stripReasoning to false to recover byte-compat with upstream.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Constants / defaults ────────────────────────────────────────────────────

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_THINKING = "high";
export const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes (upstream default)

export const DEFAULTS = Object.freeze({
  contextMode: "summary+tail",
  tailMessages: 10,
  stripReasoning: true,
  keepToolResults: "recent",
  diffMode: "stat",
  diffMaxChars: 4000,
  summaryModel: "executor",
  summaryMaxTokens: 1024,
  summaryRefreshEvery: 8,
  summaryTimeoutMs: 60_000,
});

// Config file paths (same as upstream)
export const globalConfigPath = () =>
  path.join(os.homedir(), ".pi", "agent", "advisor.json");

export const projectConfigPath = (cwd) =>
  path.join(cwd, ".pi", "advisor.json");

// ── Validation ──────────────────────────────────────────────────────────────

export function validateAdvisorConfig(raw, source = "advisor config") {
  const warn = (message) =>
    console.warn(`[pi-advisor] Ignoring invalid ${source}: ${message}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn("expected a JSON object");
    return {};
  }

  const input = raw;
  const clean = {};

  // ── existing fields ──

  if (input.model !== undefined) {
    if (typeof input.model === "string") clean.model = input.model;
    else warn('"model" must be a string');
  }

  if (input.thinking !== undefined) {
    if (typeof input.thinking === "string" && THINKING_LEVELS.includes(input.thinking)) {
      clean.thinking = input.thinking;
    } else {
      warn(`"thinking" must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
  }

  if (input.onDone !== undefined) {
    if (typeof input.onDone === "boolean") clean.onDone = input.onDone;
    else warn('"onDone" must be a boolean');
  }

  if (input.onTodoDone !== undefined) {
    if (typeof input.onTodoDone === "boolean") clean.onTodoDone = input.onTodoDone;
    else warn('"onTodoDone" must be a boolean');
  }

  if (input.whenStuck !== undefined) {
    if (
      Number.isInteger(input.whenStuck) &&
      input.whenStuck >= 0
    ) {
      clean.whenStuck = input.whenStuck;
    } else {
      warn('"whenStuck" must be a non-negative integer');
    }
  }

  if (input.timeoutMs !== undefined) {
    if (Number.isInteger(input.timeoutMs) && input.timeoutMs >= 0) {
      clean.timeoutMs = input.timeoutMs;
    } else {
      warn('"timeoutMs" must be a non-negative integer');
    }
  }

  // ── new: context policy ──

  if (input.contextMode !== undefined) {
    const modes = ["full", "tail", "summary", "summary+tail"];
    if (typeof input.contextMode === "string" && modes.includes(input.contextMode)) {
      clean.contextMode = input.contextMode;
    } else {
      warn(`"contextMode" must be one of: ${modes.join(", ")}`);
    }
  }

  if (input.tailMessages !== undefined) {
    if (
      Number.isInteger(input.tailMessages) &&
      input.tailMessages >= 2
    ) {
      clean.tailMessages = input.tailMessages;
    } else {
      warn('"tailMessages" must be an integer >= 2');
    }
  }

  if (input.stripReasoning !== undefined) {
    if (typeof input.stripReasoning === "boolean") {
      clean.stripReasoning = input.stripReasoning;
    } else {
      warn('"stripReasoning" must be a boolean');
    }
  }

  if (input.keepToolResults !== undefined) {
    const ktr = ["recent", "all", "none"];
    if (
      typeof input.keepToolResults === "string" &&
      ktr.includes(input.keepToolResults)
    ) {
      clean.keepToolResults = input.keepToolResults;
    } else {
      warn(`"keepToolResults" must be one of: ${ktr.join(", ")}`);
    }
  }

  // ── new: diff digest ──

  if (input.diffMode !== undefined) {
    const dms = ["none", "stat", "snippets", "git-stat", "git-snippets"];
    if (typeof input.diffMode === "string" && dms.includes(input.diffMode)) {
      clean.diffMode = input.diffMode;
    } else {
      warn(`"diffMode" must be one of: ${dms.join(", ")}`);
    }
  }

  if (input.diffMaxChars !== undefined) {
    if (
      Number.isInteger(input.diffMaxChars) &&
      input.diffMaxChars >= 200
    ) {
      clean.diffMaxChars = input.diffMaxChars;
    } else {
      warn('"diffMaxChars" must be an integer >= 200');
    }
  }

  // ── new: summary pre-call ──

  if (input.summaryModel !== undefined) {
    if (
      input.summaryModel === null ||
      typeof input.summaryModel === "string" ||
      input.summaryModel === "executor"
    ) {
      clean.summaryModel = input.summaryModel;
    } else {
      warn('"summaryModel" must be "executor", a provider/id spec, or null');
    }
  }

  if (input.summaryMaxTokens !== undefined) {
    if (
      Number.isInteger(input.summaryMaxTokens) &&
      input.summaryMaxTokens >= 256
    ) {
      clean.summaryMaxTokens = input.summaryMaxTokens;
    } else {
      warn('"summaryMaxTokens" must be an integer >= 256');
    }
  }

  if (input.summaryRefreshEvery !== undefined) {
    if (
      Number.isInteger(input.summaryRefreshEvery) &&
      input.summaryRefreshEvery >= 0
    ) {
      clean.summaryRefreshEvery = input.summaryRefreshEvery;
    } else {
      warn('"summaryRefreshEvery" must be a non-negative integer');
    }
  }

  if (input.summaryTimeoutMs !== undefined) {
    if (
      Number.isInteger(input.summaryTimeoutMs) &&
      input.summaryTimeoutMs >= 0
    ) {
      clean.summaryTimeoutMs = input.summaryTimeoutMs;
    } else {
      warn('"summaryTimeoutMs" must be a non-negative integer');
    }
  }

  return clean;
}

// ── File I/O ────────────────────────────────────────────────────────────────

export function readConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`[pi-advisor] Could not read ${file}: ${err?.message ?? err}`);
    }
    return {};
  }

  try {
    return validateAdvisorConfig(JSON.parse(raw), file);
  } catch (err) {
    console.warn(
      `[pi-advisor] Ignoring invalid JSON in ${file}: ${err?.message ?? err}`,
    );
    return {};
  }
}

/**
 * Write config, preserving any keys not present in `patch`.
 * Only writes keys that are defined in `patch`.
 */
export function writeConfig(file, patch) {
  const existing = readConfig(file);
  // Merge: patch wins over existing
  const merged = {};
  if (existing.model !== undefined) merged.model = existing.model;
  if (patch.model !== undefined) merged.model = patch.model;

  if (existing.thinking !== undefined) merged.thinking = existing.thinking;
  if (patch.thinking !== undefined) merged.thinking = patch.thinking;

  if (existing.onDone !== undefined) merged.onDone = existing.onDone;
  if (patch.onDone !== undefined) merged.onDone = patch.onDone;

  if (existing.onTodoDone !== undefined) merged.onTodoDone = existing.onTodoDone;
  if (patch.onTodoDone !== undefined) merged.onTodoDone = patch.onTodoDone;

  if (existing.whenStuck !== undefined) merged.whenStuck = existing.whenStuck;
  if (patch.whenStuck !== undefined) merged.whenStuck = patch.whenStuck;

  if (existing.timeoutMs !== undefined) merged.timeoutMs = existing.timeoutMs;
  if (patch.timeoutMs !== undefined) merged.timeoutMs = patch.timeoutMs;

  // New keys
  if (existing.contextMode !== undefined) merged.contextMode = existing.contextMode;
  if (patch.contextMode !== undefined) merged.contextMode = patch.contextMode;

  if (existing.tailMessages !== undefined) merged.tailMessages = existing.tailMessages;
  if (patch.tailMessages !== undefined) merged.tailMessages = patch.tailMessages;

  if (existing.stripReasoning !== undefined) merged.stripReasoning = existing.stripReasoning;
  if (patch.stripReasoning !== undefined) merged.stripReasoning = patch.stripReasoning;

  if (existing.keepToolResults !== undefined) merged.keepToolResults = existing.keepToolResults;
  if (patch.keepToolResults !== undefined) merged.keepToolResults = patch.keepToolResults;

  if (existing.diffMode !== undefined) merged.diffMode = existing.diffMode;
  if (patch.diffMode !== undefined) merged.diffMode = patch.diffMode;

  if (existing.diffMaxChars !== undefined) merged.diffMaxChars = existing.diffMaxChars;
  if (patch.diffMaxChars !== undefined) merged.diffMaxChars = patch.diffMaxChars;

  if (existing.summaryModel !== undefined) merged.summaryModel = existing.summaryModel;
  if (patch.summaryModel !== undefined) merged.summaryModel = patch.summaryModel;

  if (existing.summaryMaxTokens !== undefined) merged.summaryMaxTokens = existing.summaryMaxTokens;
  if (patch.summaryMaxTokens !== undefined) merged.summaryMaxTokens = patch.summaryMaxTokens;

  if (existing.summaryRefreshEvery !== undefined) merged.summaryRefreshEvery = existing.summaryRefreshEvery;
  if (patch.summaryRefreshEvery !== undefined) merged.summaryRefreshEvery = patch.summaryRefreshEvery;

  if (existing.summaryTimeoutMs !== undefined) merged.summaryTimeoutMs = existing.summaryTimeoutMs;
  if (patch.summaryTimeoutMs !== undefined) merged.summaryTimeoutMs = patch.summaryTimeoutMs;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// ── Resolution ──────────────────────────────────────────────────────────────

function envThinkingLevel() {
  const env = process.env.PI_ADVISOR_EFFORT?.trim();
  return env && THINKING_LEVELS.includes(env) ? env : undefined;
}

function envModelSpec() {
  const env = process.env.PI_ADVISOR_MODEL?.trim();
  if (env) return { spec: env, source: "env PI_ADVISOR_MODEL" };
  return undefined;
}

function envContextMode() {
  const env = process.env.PI_ADVISOR_CONTEXT_MODE?.trim();
  if (!env) return undefined;
  const modes = ["full", "tail", "summary", "summary+tail"];
  return modes.includes(env) ? env : undefined;
}

function envTail() {
  const env = process.env.PI_ADVISOR_TAIL;
  if (!env) return undefined;
  const n = Number(env);
  return Number.isInteger(n) && n >= 2 ? n : undefined;
}

function envSummaryModel() {
  const env = process.env.PI_ADVISOR_SUMMARY_MODEL?.trim();
  if (!env) return undefined;
  return env === "executor" ? "executor" : env || null;
}

function envOnTodoDone() {
  const env = process.env.PI_ADVISOR_ON_TODO_DONE;
  if (!env) return undefined;
  if (env === "1") return true;
  if (env === "0") return false;
  return undefined;
}

function envDiffMode() {
  const env = process.env.PI_ADVISOR_DIFF_MODE?.trim();
  if (!env) return undefined;
  const dms = ["none", "stat", "snippets", "git-stat", "git-snippets"];
  return dms.includes(env) ? env : undefined;
}

function envStripReasoning() {
  const env = process.env.PI_ADVISOR_STRIP_REASONING;
  if (!env) return undefined;
  return env === "1" || env.toLowerCase() === "true";
}

function envTimeoutMs() {
  const env = process.env.PI_ADVISOR_TIMEOUT_MS;
  if (!env) return undefined;
  const n = Number(env);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function resolveEffectiveConfig(cwd, projectTrusted = true) {
  // Read project + global configs (project is skipped if not trusted)
  const project = projectTrusted ? readConfig(projectConfigPath(cwd)) : {};
  const global = readConfig(globalConfigPath());

  // Model resolution (same precedence as upstream)
  let model;
  const envModel = envModelSpec();
  if (envModel) {
    model = envModel;
  } else if (project.model !== undefined) {
    model = { spec: project.model, source: "project" };
  } else if (global.model !== undefined) {
    model = { spec: global.model, source: "global" };
  } else {
    model = { spec: undefined, source: "default" };
  }

  // Helper: env > project > global > default
  const pick = (envVal, projVal, globVal, defVal) =>
    envVal ?? projVal ?? globVal ?? defVal;

  return {
    ...model,

    // Existing fields
    thinking: pick(envThinkingLevel(), project.thinking, global.thinking, DEFAULT_THINKING),
    onDone: project.onDone ?? global.onDone ?? false,
    onTodoDone: envOnTodoDone() ?? project.onTodoDone ?? global.onTodoDone ?? false,
    whenStuck: project.whenStuck ?? global.whenStuck ?? 0,
    timeoutMs: envTimeoutMs() ?? project.timeoutMs ?? global.timeoutMs ?? DEFAULT_TIMEOUT_MS,

    // New fields (defaults set to fork defaults)
    contextMode: pick(envContextMode(), project.contextMode, global.contextMode, DEFAULTS.contextMode),
    tailMessages: pick(envTail(), project.tailMessages, global.tailMessages, DEFAULTS.tailMessages),
    stripReasoning: pick(envStripReasoning(), project.stripReasoning, global.stripReasoning, DEFAULTS.stripReasoning),
    keepToolResults: pick(
      undefined, // no env var yet
      project.keepToolResults,
      global.keepToolResults,
      DEFAULTS.keepToolResults,
    ),
    diffMode: pick(envDiffMode(), project.diffMode, global.diffMode, DEFAULTS.diffMode),
    diffMaxChars:
      project.diffMaxChars ?? global.diffMaxChars ?? DEFAULTS.diffMaxChars,
    summaryModel:
      pick(envSummaryModel(), project.summaryModel, global.summaryModel, DEFAULTS.summaryModel),
    summaryMaxTokens:
      project.summaryMaxTokens ?? global.summaryMaxTokens ?? DEFAULTS.summaryMaxTokens,
    summaryRefreshEvery:
      project.summaryRefreshEvery ?? global.summaryRefreshEvery ?? DEFAULTS.summaryRefreshEvery,
    summaryTimeoutMs:
      project.summaryTimeoutMs ?? global.summaryTimeoutMs ?? DEFAULTS.summaryTimeoutMs,
  };
}

/**
 * Downgrade git-* diff modes to non-git variants when project is untrusted.
 * Returns the effective diff mode and a warning string (or null).
 */
export function normalizeDiffMode(mode, projectTrusted) {
  if (!projectTrusted && (mode === "git-stat" || mode === "git-snippets")) {
    const fallback = mode === "git-stat" ? "stat" : "snippets";
    return {
      effectiveMode: fallback,
      warning: `[pi-advisor] downgraded diffMode "${mode}" → "${fallback}" (project not trusted)`,
    };
  }
  return { effectiveMode: mode };
}

// ── Thin helpers for backward compatibility ──────────────────────────────────

/** Extracted from upstream — kept here so advisor.ts can call the old names. */
export function isDisabled(cfg) {
  return cfg.spec === "none";
}

/** Extracted from upstream — kept here so advisor.ts can call the old names. */
export function isUnconfigured(cfg) {
  return cfg.spec === undefined;
}
