/**
 * diff.ts — changed-files digest: harvest from events + branch fallback.
 *
 * Pure module: no pi imports. Unit-testable with `node --test`.
 *
 * `countPatchChanges` and `isVerificationCommand` adapted from
 * github.com/RimuruW/pi-advisor/src/advisor-signals.ts (MIT/proprietary).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import type { DiffMode } from "./config.ts";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Slim projection of a tool_result event for diff harvesting. */
export type ChangeEvent =
  | { kind: "edit";   path: string; edits: Array<{ oldText: string; newText: string }>; isError: boolean; ts: number }
  | { kind: "write";  path: string; content: string; isError: boolean; ts: number }
  | { kind: "bash";   command: string; isError: boolean; ts: number };

/** Aggregated per-file change. */
export type FileChange = {
  path: string;
  added: number;
  removed: number;
  writtenLines?: number;
  snippet?: string;
};

// ── Patch stats (copied from RimuruW/advisor-signals.ts, attributed) ──────────

/** Count added/removed lines in a unified patch string. Skips +++/--- headers. */
export function countPatchChanges(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

// ── Verification detection (adapted from RimuruW/advisor-signals.ts) ─────────

const VERIFICATION_SEGMENT_PATTERNS: RegExp[] = [
  /^(?:npx\s+|bunx\s+)?(?:jest|vitest|pytest|rspec|tsc|eslint|biome|mocha|ava)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|build)\b/,
  /^cargo\s+(?:test|check|clippy|build)\b/,
  /^go\s+(?:test|vet|build)\b/,
  /^make\s+(?:test|check|lint|build)\b/,
  /^node\s+--test\b/,
  /^python3?\s+-m\s+pytest\b/,
];

/** Detect whether a bash command is a test/verification runner. */
export function isVerificationCommand(command?: string): boolean {
  if (!command) return false;
  return command.split(/&&|\|\||;|\|/).some((segment) => {
    const normalized = segment.trim().replace(/^(?:\w+=\S+\s+)+/, "");
    return VERIFICATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

// ── Harvest from tool_result events (primary source) ──────────────────────────

/**
 * Collect file changes from accumulated tool_result events.
 * Aggregates by path: edits are merged, writes replace.
 */
export function collectChangesFromEvents(
  events: ChangeEvent[],
  diffMode: DiffMode,
  maxChars: number,
): FileChange[] {
  // Aggregate edits by path
  const editsByPath = new Map<string, Array<{ oldText: string; newText: string }>>();   // path -> edits
  const writesByPath = new Map<string, string>();                                         // path -> content
  const verifications = new Set<string>();                                                // commands

  for (const ev of events) {
    if (ev.kind === "edit") {
      const edits = editsByPath.get(ev.path) ?? [];
      edits.push(...ev.edits);
      editsByPath.set(ev.path, edits);
    } else if (ev.kind === "write") {
      writesByPath.set(ev.path, ev.content);
    } else if (ev.kind === "bash") {
      if (isVerificationCommand(ev.command)) {
        verifications.add(ev.command);
      }
    }
  }

  const changes: FileChange[] = [];

  // Process edits
  for (const [filePath, edits] of editsByPath) {
    // Reconstruct a unified patch from the edits for stats
    const unified = edits
      .map((e) => `--- a/${filePath}\n+++ b/${filePath}\n` + e.oldText.split("\n").map((l) => `-${l}`).join("\n") + "\n" + e.newText.split("\n").map((l) => `+${l}`).join("\n"))
      .join("\n");
    const { added, removed } = countPatchChanges(unified);
    const change: FileChange = { path: filePath, added, removed };

    if (diffMode === "snippets" && unified.length > 0) {
      change.snippet = truncateUnifiedHunk(unified, maxChars);
    }

    changes.push(change);
  }

  // Process writes (may overlap with edits — writes replace)
  for (const [filePath, content] of writesByPath) {
    const writtenLines = content.split("\n").length;
    const existing = changes.findIndex((c) => c.path === filePath);
    if (existing >= 0) {
      // Already has edit stats; augment with snippet
      if (diffMode === "snippets") {
        changes[existing].snippet = getWriteSnippet(content, maxChars);
      }
    } else {
      changes.push({
        path: filePath,
        added: writtenLines,
        removed: 0,
        writtenLines,
        ...(diffMode === "snippets" ? { snippet: getWriteSnippet(content, maxChars) } : {}),
      });
    }
  }

  return changes;
}

// ── Harvest from branch toolCall args (fallback) ─────────────────────────────

type AnyEntry = { type?: string; message?: any };

/**
 * Fallback: reconstruct changes from branch entries when events were missed.
 * Walks assistant toolCall blocks to find edit/write arguments.
 */
export function collectChangesFromBranch(
  entries: AnyEntry[],
  diffMode: DiffMode,
  maxChars: number,
): FileChange[] {
  const editsByPath = new Map<string, { oldText: string; newText: string }[]>();
  const writesByPath = new Map<string, { content: string }>();
  const verifications = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const msg = entry.message;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || block.type !== "toolCall" || typeof block.name !== "string") continue;

        if (block.name === "edit" && Array.isArray(block.arguments?.edits)) {
          const pathArg = typeof block.arguments.path === "string" ? block.arguments.path : "";
          const edits = editsByPath.get(pathArg) ?? [];
          for (const edit of block.arguments.edits) {
            if (edit && typeof edit === "object") {
              edits.push({
                oldText: typeof edit.oldText === "string" ? edit.oldText : "",
                newText: typeof edit.newText === "string" ? edit.newText : "",
              });
            }
          }
          editsByPath.set(pathArg, edits);
        }

        if (block.name === "write" && block.arguments && typeof block.arguments === "object") {
          const pathArg = typeof block.arguments.path === "string" ? block.arguments.path : "";
          writesByPath.set(pathArg, { content: typeof block.arguments.content === "string" ? block.arguments.content : "" });
        }

        if (block.name === "bash" && block.arguments && typeof block.arguments === "object" && typeof block.arguments.command === "string") {
          if (isVerificationCommand(block.arguments.command)) {
            verifications.add(block.arguments.command);
          }
        }
      }
    }

    if (msg.role === "toolResult" && typeof msg.command === "string" && msg.isError) {
      // Not really helpful for diff, but track verification
    }
  }

  const changes: FileChange[] = [];

  // Process edits (reconstruct +/- from oldText/newText line counts)
  for (const [filePath, edits] of editsByPath) {
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      added += edit.newText.split("\n").length;
      removed += edit.oldText.split("\n").length;
    }
    const change: FileChange = { path: filePath, added, removed };

    if (diffMode === "snippets" && edits.length > 0) {
      // Show newText of largest edit
      const largest = edits.reduce((a, b) =>
        b.newText.length > a.newText.length ? b : a
      );
      change.snippet = truncateText(largest.newText, maxChars, filePath);
    }

    changes.push(change);
  }

  // Process writes
  for (const [filePath, { content }] of writesByPath) {
    const writtenLines = content.split("\n").length;
    const existing = changes.findIndex((c) => c.path === filePath);
    if (existing >= 0) {
      if (diffMode === "snippets") {
        changes[existing].snippet = getWriteSnippet(content, maxChars);
      }
    } else {
      changes.push({
        path: filePath,
        added: writtenLines,
        removed: 0,
        writtenLines,
        ...(diffMode === "snippets" ? { snippet: getWriteSnippet(content, maxChars) } : {}),
      });
    }
  }

  return changes;
}

// ── Git-based diff (opt-in for trusted cwd) ──────────────────────────────────

/**
 * Run git diff and return stat or snippet output.
 * Returns null on failure (non-git dir, no git, timeout).
 */
export async function tryGitDiff(
  cwd: string,
  mode: "git-stat" | "git-snippets",
  maxChars: number,
): Promise<string | null> {
  try {
    const { timeout } = await import("node:timers/promises");
    const timeoutMs = 5000; // 5s cap for git

    const [stdout] = await Promise.race([
      execFileAsync("git", ["diff", "--no-color", mode === "git-stat" ? "--stat" : ""], {
        cwd,
        maxBuffer: maxChars * 10,
      }),
      timeout(timeoutMs),
    ] as const);

    const result = stdout?.trim() ?? "";
    return result.length > 0 ? result.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the changed-files digest.
 *
 * @param changes — FileChange[] from harvest
 * @param verifications — verification bash commands seen
 * @param diffMode — rendering mode
 * @param maxChars — cap total digest size
 */
export function renderDigest(
  changes: FileChange[],
  verifications: string[],
  diffMode: DiffMode,
  maxChars: number,
): string {
  const lines: string[] = [];
  lines.push("Changed files:");

  let totalChars = lines.join("\n").length + 1;

  for (const c of changes) {
    if (diffMode === "stat") {
      const statLine = c.writtenLines !== undefined
        ? `  ${c.path}    (rewritten, ${c.writtenLines} lines)`
        : `  ${c.path}    +${c.added} -${c.removed}`;
      lines.push(statLine);
    } else if (diffMode === "snippets") {
      if (c.snippet) {
        lines.push(`  ${c.path} (+${c.added}/-${c.removed}):`);
        lines.push(c.snippet);
      } else {
        const statLine = c.writtenLines !== undefined
          ? `  ${c.path}    (rewritten, ${c.writtenLines} lines)`
          : `  ${c.path}    +${c.added} -${c.removed}`;
        lines.push(statLine);
      }
    } else {
      // "none" mode shouldn't reach here, but be safe
      lines.push(`  ${c.path}`);
    }
    totalChars = lines.join("\n").length;
    if (totalChars >= maxChars) {
      lines.push("  [digest truncated]");
      break;
    }
  }

  // Verification runs
  if (verifications.length > 0) {
    const vLines = verifications.slice(0, 3).map((v) => `Verification run: ${v}`);
    totalChars = lines.join("\n").length + vLines.join("\n").length + 2;
    if (totalChars <= maxChars) {
      lines.push("");
      lines.push(...vLines);
    } else {
      lines.push("");
      lines.push(`Verification run: ${verifications[0]}`);
    }
  }

  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "\n[digest truncated]" : result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a capped unified hunk from a patch (for snippets mode). */
function truncateUnifiedHunk(patch: string, maxChars: number): string {
  // Show first 30 lines of the patch (header + 2-3 hunks)
  const lines = patch.split("\n");
  const head = lines.slice(0, 30).join("\n");
  if (head.length <= maxChars) return head;
  return head.slice(0, maxChars) + "\n…[hunk truncated]";
}

/** Show first/last ~10 lines of a rewritten file with a marker. */
function getWriteSnippet(content: string, maxChars: number): string {
  const lines = content.split("\n");
  const total = lines.length;
  if (total <= 20) return content.slice(0, maxChars);

  const head = lines.slice(0, 10).join("\n");
  const tail = lines.slice(-10).join("\n");
  const snippet = `${head}\n[… ${total - 20} lines total …]\n${tail}`;
  return snippet.length > maxChars ? snippet.slice(0, maxChars) : snippet;
}

/** Truncate plain text with file path marker. */
function truncateText(text: string, maxChars: number, label: string): string {
  const header = `${label}:`;
  const body = text.slice(0, maxChars - header.length - 3);
  return body.length < text.length ? `${header}\n${body}…` : `${header}\n${body}`;
}
