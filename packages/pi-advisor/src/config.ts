/**
 * config.ts — extended advisor configuration types, validation, and resolution.
 *
 * Pure module: no pi imports. Extracted and extended from upstream
 * hknet/pi-extensions/packages/pi-advisor/advisor.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_THINKING: ThinkingLevel = "high";

export type ContextMode = "full" | "tail" | "summary" | "summary+tail";
export type DiffMode = "none" | "stat" | "snippets" | "git-stat" | "git-snippets";
export type KeepToolResults = "recent" | "all" | "none";

export type AdvisorConfig = {
  // Existing (unchanged semantics from upstream)
  model?: string;
  thinking?: ThinkingLevel;
  onDone?: boolean;
  onTodoDone?: boolean;
  whenStuck?: number;
  timeoutMs?: number;
  // New: context policy
  contextMode?: ContextMode;
  tailMessages?: number;
  stripReasoning?: boolean;
  keepToolResults?: KeepToolResults;
  // New: changed-files / diff digest
  diffMode?: DiffMode;
  diffMaxChars?: number;
  // New: summary pre-call
  summaryModel?: string | null;
  summaryMaxTokens?: number;
  summaryRefreshEvery?: number;
  summaryTimeoutMs?: number;
};

// ── Defaults (D1, D2, D4) ───────────────────────────────────────────────────

export const DEFAULTS = {
  contextMode: "summary+tail" as const,
  tailMessages: 10,
  stripReasoning: true,
  keepToolResults: "recent" as const,
  diffMode: "stat" as const,
  diffMaxChars: 4000,
  summaryModel: "executor",
  summaryMaxTokens: 1024,
  summaryRefreshEvery: 8,
  summaryTimeoutMs: 60000,
} as const;

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_CONTEXT_MODES: ContextMode[] = ["full", "tail", "summary", "summary+tail"];
const VALID_DIFF_MODES: DiffMode[] = ["none", "stat", "snippets", "git-stat", "git-snippets"];
const VALID_KEEP_TOOL_RESULTS: KeepToolResults[] = ["recent", "all", "none"];

export function validateAdvisorConfig(raw: unknown, source = "advisor config"): AdvisorConfig {
  const warn = (message: string) => console.warn(`[pi-advisor] Ignoring invalid ${source}: ${message}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn("expected a JSON object");
    return {};
  }

  const input = raw as Record<string, unknown>;
  const clean: AdvisorConfig = {};

  // ── Existing keys (from upstream) ────────────────────────────────────────

  if (input.model !== undefined) {
    if (typeof input.model === "string") clean.model = input.model;
    else warn('"model" must be a string');
  }
  if (input.thinking !== undefined) {
    if (typeof input.thinking === "string" && THINKING_LEVELS.includes(input.thinking as ThinkingLevel)) {
      clean.thinking = input.thinking as ThinkingLevel;
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
  if (input.whenStuck !== undefined && typeof input.whenStuck === "number" && Number.isInteger(input.whenStuck) && input.whenStuck >= 0) {
    clean.whenStuck = input.whenStuck;
  } else if (input.whenStuck !== undefined) {
    warn('"whenStuck" must be a non-negative integer');
  }
  if (input.timeoutMs !== undefined && typeof input.timeoutMs === "number" && Number.isInteger(input.timeoutMs) && input.timeoutMs >= 0) {
    clean.timeoutMs = input.timeoutMs;
  } else if (input.timeoutMs !== undefined) {
    warn('"timeoutMs" must be a non-negative integer');
  }

  // ── New: context policy ──────────────────────────────────────────────────

  if (input.contextMode !== undefined) {
    if (typeof input.contextMode === "string" && VALID_CONTEXT_MODES.includes(input.contextMode as ContextMode)) {
      clean.contextMode = input.contextMode as ContextMode;
    } else {
      warn(`"contextMode" must be one of: ${VALID_CONTEXT_MODES.join(", ")}`);
    }
  }
  if (input.tailMessages !== undefined && typeof input.tailMessages === "number" && Number.isInteger(input.tailMessages) && input.tailMessages >= 2) {
    clean.tailMessages = input.tailMessages;
  } else if (input.tailMessages !== undefined) {
    warn('"tailMessages" must be an integer >= 2');
  }
  if (input.stripReasoning !== undefined) {
    if (typeof input.stripReasoning === "boolean") clean.stripReasoning = input.stripReasoning;
    else warn('"stripReasoning" must be a boolean');
  }
  if (input.keepToolResults !== undefined) {
    if (typeof input.keepToolResults === "string" && VALID_KEEP_TOOL_RESULTS.includes(input.keepToolResults as KeepToolResults)) {
      clean.keepToolResults = input.keepToolResults as KeepToolResults;
    } else {
      warn(`"keepToolResults" must be one of: ${VALID_KEEP_TOOL_RESULTS.join(", ")}`);
    }
  }

  // ── New: diff digest ─────────────────────────────────────────────────────

  if (input.diffMode !== undefined) {
    if (typeof input.diffMode === "string" && VALID_DIFF_MODES.includes(input.diffMode as DiffMode)) {
      clean.diffMode = input.diffMode as DiffMode;
    } else {
      warn(`"diffMode" must be one of: ${VALID_DIFF_MODES.join(", ")}`);
    }
  }
  if (input.diffMaxChars !== undefined && typeof input.diffMaxChars === "number" && Number.isInteger(input.diffMaxChars) && input.diffMaxChars >= 200) {
    clean.diffMaxChars = input.diffMaxChars;
  } else if (input.diffMaxChars !== undefined) {
    warn('"diffMaxChars" must be an integer >= 200');
  }

  // ── New: summary pre-call ────────────────────────────────────────────────

  if (input.summaryModel !== undefined) {
    const sm = input.summaryModel;
    if (sm === null || sm === "executor" || (typeof sm === "string" && sm.includes("/"))) {
      clean.summaryModel = sm as string | null;
    } else if (typeof sm === "string" && sm === "off") {
      clean.summaryModel = null;
    } else {
      warn('"summaryModel" must be "executor", a "provider/id" spec, "off", or null');
    }
  }
  if (input.summaryMaxTokens !== undefined && typeof input.summaryMaxTokens === "number" && Number.isInteger(input.summaryMaxTokens) && input.summaryMaxTokens >= 256) {
    clean.summaryMaxTokens = input.summaryMaxTokens;
  } else if (input.summaryMaxTokens !== undefined) {
    warn('"summaryMaxTokens" must be an integer >= 256');
  }
  if (input.summaryRefreshEvery !== undefined && typeof input.summaryRefreshEvery === "number" && Number.isInteger(input.summaryRefreshEvery) && input.summaryRefreshEvery >= 0) {
    clean.summaryRefreshEvery = input.summaryRefreshEvery;
  } else if (input.summaryRefreshEvery !== undefined) {
    warn('"summaryRefreshEvery" must be a non-negative integer');
  }
  if (input.summaryTimeoutMs !== undefined && typeof input.summaryTimeoutMs === "number" && Number.isInteger(input.summaryTimeoutMs) && input.summaryTimeoutMs >= 0) {
    clean.summaryTimeoutMs = input.summaryTimeoutMs;
  } else if (input.summaryTimeoutMs !== undefined) {
    warn('"summaryTimeoutMs" must be a non-negative integer');
  }

  return clean;
}

// ── Resolution ────────────────────────────────────────────────────────────────

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const globalConfigPath = () => path.join(os.homedir(), ".pi", "agent", "advisor.json");
export const projectConfigPath = (cwd: string) => path.join(cwd, ".pi", "advisor.json");

const DEFAULT_TIMEOUT_MS = 120_000;

const GIT_MODE_DOWNGRADE: Record<DiffMode, DiffMode> = {
  "git-stat": "stat",
  "git-snippets": "snippets",
  "none": "none",
  "stat": "stat",
  "snippets": "snippets",
};

function readConfig(file: string): AdvisorConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== "ENOENT") console.warn(`[pi-advisor] Could not read ${file}: ${(err as Error)?.message ?? err}`);
    return {};
  }
  try {
    return validateAdvisorConfig(JSON.parse(raw), file);
  } catch (err: unknown) {
    console.warn(`[pi-advisor] Ignoring invalid JSON in ${file}: ${(err as Error)?.message ?? err}`);
    return {};
  }
}

function envThinkingLevel(): ThinkingLevel | undefined {
  const env = process.env.PI_ADVISOR_EFFORT?.trim();
  return env && THINKING_LEVELS.includes(env as ThinkingLevel) ? (env as ThinkingLevel) : undefined;
}

function envTimeoutMs(): number | undefined {
  const env = process.env.PI_ADVISOR_TIMEOUT_MS;
  if (!env) return undefined;
  const n = Number(env);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function envContextMode(): ContextMode | undefined {
  const env = process.env.PI_ADVISOR_CONTEXT_MODE;
  if (!env) return undefined;
  return (VALID_CONTEXT_MODES as readonly string[]).includes(env) ? (env as ContextMode) : undefined;
}

function envTail(): number | undefined {
  const env = process.env.PI_ADVISOR_TAIL;
  if (!env) return undefined;
  const n = Number(env);
  return Number.isInteger(n) && n >= 2 ? n : undefined;
}

function envStripReasoning(): boolean | undefined {
  const env = process.env.PI_ADVISOR_STRIP_REASONING;
  if (!env) return undefined;
  if (env === "1") return true;
  if (env === "0") return false;
  return undefined;
}

function envSummaryModel(): string | null | undefined {
  const env = process.env.PI_ADVISOR_SUMMARY_MODEL;
  if (!env) return undefined;
  if (env === "executor") return "executor";
  if (env === "off" || env === "") return null;
  if (env.includes("/")) return env;
  return undefined;
}

function envOnTodoDone(): boolean | undefined {
  const env = process.env.PI_ADVISOR_ON_TODO_DONE;
  if (!env) return undefined;
  if (env === "1") return true;
  if (env === "0") return false;
  return undefined;
}

function envDiffMode(): DiffMode | undefined {
  const env = process.env.PI_ADVISOR_DIFF_MODE;
  if (!env) return undefined;
  return (VALID_DIFF_MODES as readonly string[]).includes(env) ? (env as DiffMode) : undefined;
}

type EffectiveAdvisorConfig = {
  spec: string | undefined;
  source: string;
  thinking: ThinkingLevel;
  onDone: boolean;
  onTodoDone: boolean;
  whenStuck: number;
  timeoutMs: number;
  // New
  contextMode: ContextMode;
  tailMessages: number;
  stripReasoning: boolean;
  keepToolResults: KeepToolResults;
  diffMode: DiffMode;
  diffMaxChars: number;
  summaryModel: string | null;
  summaryMaxTokens: number;
  summaryRefreshEvery: number;
  summaryTimeoutMs: number;
};

/**
 * Resolve the full effective config.
 *
 * Precedence (per-key): env > project > global > DEFAULTS.
 *
 * @param cwd — working directory for project config resolution
 * @param projectTrusted — whether project config is allowed (git-* diff modes
 *   only apply when trusted)
 */
export function resolveEffectiveConfig(cwd: string, projectTrusted = true): EffectiveAdvisorConfig {
  const project = projectTrusted ? readConfig(projectConfigPath(cwd)) : {};
  const global = readConfig(globalConfigPath());
  const envModel = process.env.PI_ADVISOR_MODEL?.trim();

  // Model resolution (unchanged from upstream)
  let spec: string | undefined;
  let source: string;
  if (envModel) {
    spec = envModel;
    source = "env PI_ADVISOR_MODEL";
  } else if (project.model !== undefined) {
    spec = project.model;
    source = "project";
  } else if (global.model !== undefined) {
    spec = global.model;
    source = "global";
  } else {
    spec = undefined;
    source = "default";
  }

  const downgradeDiffMode = (dm: DiffMode): DiffMode => {
    if (!projectTrusted && (dm === "git-stat" || dm === "git-snippets")) {
      console.warn(`[pi-advisor] Downgrading diffMode "${dm}" to "${GIT_MODE_DOWNGRADE[dm]}" (project not trusted)`);
      return GIT_MODE_DOWNGRADE[dm];
    }
    return dm;
  };

  return {
    spec,
    source,
    thinking: envThinkingLevel() ?? project.thinking ?? global.thinking ?? DEFAULT_THINKING,
    onDone: project.onDone ?? global.onDone ?? false,
    onTodoDone: envOnTodoDone() ?? project.onTodoDone ?? global.onTodoDone ?? false,
    whenStuck: project.whenStuck ?? global.whenStuck ?? 0,
    timeoutMs: envTimeoutMs() ?? project.timeoutMs ?? global.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // New defaults with env override
    contextMode: envContextMode() ?? project.contextMode ?? global.contextMode ?? DEFAULTS.contextMode,
    tailMessages: envTail() ?? project.tailMessages ?? global.tailMessages ?? DEFAULTS.tailMessages,
    stripReasoning: envStripReasoning() ?? project.stripReasoning ?? global.stripReasoning ?? DEFAULTS.stripReasoning,
    keepToolResults: project.keepToolResults ?? global.keepToolResults ?? DEFAULTS.keepToolResults,
    diffMode: downgradeDiffMode(envDiffMode() ?? project.diffMode ?? global.diffMode ?? DEFAULTS.diffMode),
    diffMaxChars: project.diffMaxChars ?? global.diffMaxChars ?? DEFAULTS.diffMaxChars,
    // Use explicit undefined check (not ??) so summaryModel: null (off) is not
    // treated as "not set" and falling through to global/default.
    summaryModel: (() => {
      const e = envSummaryModel();
      return e !== undefined
        ? e
        : project.summaryModel !== undefined
          ? project.summaryModel
          : global.summaryModel !== undefined
            ? global.summaryModel
            : DEFAULTS.summaryModel;
    })(),
    summaryMaxTokens: project.summaryMaxTokens ?? global.summaryMaxTokens ?? DEFAULTS.summaryMaxTokens,
    summaryRefreshEvery: project.summaryRefreshEvery ?? global.summaryRefreshEvery ?? DEFAULTS.summaryRefreshEvery,
    summaryTimeoutMs: project.summaryTimeoutMs ?? global.summaryTimeoutMs ?? DEFAULTS.summaryTimeoutMs,
  };
}

// Convenience accessors (for backward-compat with upstream code patterns)
export function effectiveModelSpec(cwd: string, projectTrusted = true): { spec: string | undefined; source: string } {
  const cfg = resolveEffectiveConfig(cwd, projectTrusted);
  return { spec: cfg.spec, source: cfg.source };
}

export function effectiveThinking(cwd: string, projectTrusted = true): ThinkingLevel {
  return resolveEffectiveConfig(cwd, projectTrusted).thinking;
}

export function effectiveTriggers(cwd: string, projectTrusted = true): { onDone: boolean; whenStuck: number; onTodoDone: boolean } {
  const cfg = resolveEffectiveConfig(cwd, projectTrusted);
  return { onDone: cfg.onDone, whenStuck: cfg.whenStuck, onTodoDone: cfg.onTodoDone };
}

export function effectiveTimeoutMs(cwd: string, projectTrusted = true): number {
  return resolveEffectiveConfig(cwd, projectTrusted).timeoutMs;
}

export const DISABLED = "none";
export function isDisabled(cwd: string, projectTrusted = true): boolean {
  return resolveEffectiveConfig(cwd, projectTrusted).spec === DISABLED;
}

export function isUnconfigured(cwd: string, projectTrusted = true): boolean {
  return resolveEffectiveConfig(cwd, projectTrusted).spec === undefined;
}

// Write-back for /advisor config commands (only writes known keys, preserves others)
export function writeConfig(file: string, cfg: AdvisorConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readConfig(file);
  const merge = { ...existing, ...cfg };
  // Only write known keys (strip undefined)
  const keys: (keyof AdvisorConfig)[] = [
    "model", "thinking", "onDone", "onTodoDone", "whenStuck", "timeoutMs",
    "contextMode", "tailMessages", "stripReasoning", "keepToolResults",
    "diffMode", "diffMaxChars", "summaryModel", "summaryMaxTokens",
    "summaryRefreshEvery", "summaryTimeoutMs",
  ];
  const filtered: Record<string, unknown> = {};
  for (const k of keys) {
    if (merge[k] !== undefined) filtered[k] = merge[k];
  }
  fs.writeFileSync(file, JSON.stringify(filtered, null, 2) + "\n", "utf-8");
}

// Determine whether project-level advisor config is allowed.
// Extracts `isProjectTrusted` from an ExtensionContext when available;
// falls back to trusting by default for plain { cwd } objects.
export function contextProjectTrusted(
  ctx: ExtensionContext | { cwd: string },
): boolean {
  const fn = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted;
  return typeof fn === "function" ? fn.call(ctx) : true;
}

// ── Subcommand validators (pure functions, testable, zero side effects) ──────
// Each returns { patch: AdvisorConfig } on success or { error: string } on failure.
// The handler dispatches to these, then calls pickScope() → persist() → notify().

export type AdvisorPatchResult = { ok: true; patch: AdvisorConfig } | { ok: false; error: string };

/** Parse /advisor context <mode>. Returns contextMode patch or error. */
export function parseContextMode(arg: string | undefined): AdvisorPatchResult {
  const v = arg?.toLowerCase();
  if (!v || !(VALID_CONTEXT_MODES as readonly string[]).includes(v)) {
    return { ok: false, error: `Usage: /advisor context <${VALID_CONTEXT_MODES.join("|")}>` };
  }
  return { ok: true, patch: { contextMode: v as ContextMode } };
}

/** Parse /advisor tail <N>. Returns tailMessages patch or error. */
export function parseTailMessages(arg: string | undefined): AdvisorPatchResult {
  const n = arg !== undefined ? Number(arg) : NaN;
  if (!Number.isInteger(n) || n < 2) {
    return { ok: false, error: `Usage: /advisor tail <N>  (integer >= 2)` };
  }
  return { ok: true, patch: { tailMessages: n } };
}

/** Parse /advisor diff <mode>. Returns diffMode patch or error. */
export function parseDiffMode(arg: string | undefined): AdvisorPatchResult {
  const v = arg?.toLowerCase();
  if (!v || !(VALID_DIFF_MODES as readonly string[]).includes(v)) {
    return { ok: false, error: `Usage: /advisor diff <${VALID_DIFF_MODES.join("|")}>` };
  }
  return { ok: true, patch: { diffMode: v as DiffMode } };
}

/** Parse /advisor strip-reasoning <on|off>. Returns stripReasoning patch or error. */
export function parseStripReasoning(arg: string | undefined): AdvisorPatchResult {
  const v = arg?.toLowerCase();
  if (v !== "on" && v !== "off") {
    return { ok: false, error: `Usage: /advisor strip-reasoning on|off` };
  }
  return { ok: true, patch: { stripReasoning: v === "on" } };
}

/**
 * Parse /advisor summary-model <executor|off|provider/id>.
 * findModel checks the registry (injected by the handler to avoid pi dependency).
 * Returns summaryModel patch or error.
 */
export function parseSummaryModel(
  arg: string | undefined,
  findModel: (provider: string, id: string) => boolean,
): AdvisorPatchResult {
  if (!arg) {
    return { ok: false, error: `Usage: /advisor summary-model executor|off|<provider/id>` };
  }
  if (arg === "executor") return { ok: true, patch: { summaryModel: "executor" } };
  if (arg === "off") return { ok: true, patch: { summaryModel: null } };

  // provider/id — validate spec shape and registry presence
  const slashIdx = arg.indexOf("/");
  if (slashIdx <= 0 || slashIdx === arg.length - 1) {
    return { ok: false, error: `Unknown summary model "${arg}". Use "executor", "off", or provider/id.` };
  }
  const provider = arg.slice(0, slashIdx);
  const id = arg.slice(slashIdx + 1);
  if (!findModel(provider, id)) {
    return { ok: false, error: `Unknown summary model "${arg}" (not in registry).` };
  }
  return { ok: true, patch: { summaryModel: arg } };
}
