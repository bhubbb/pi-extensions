/**
 * src/diff.mjs — pure changed-files digest for the advisor context policy.
 *
 * Harvests file changes from two sources:
 *   1. Primary: the tool_result event stream (has details.patch from pi's
 *      edit tool — a pre-computed unified diff string).
 *   2. Fallback: the branch entries (toolCall.args, no patch — reconstruct
 *      +/− from oldText/newText line deltas).
 *
 * Also supports opt-in `git-stat` / `git-snippets` modes that shell out to
 * `git diff --stat` / `git diff` in the cwd (see §3.4 of the impl design).
 *
 * Pure functions — no pi imports, unit-testable with `node --test`.
 *
 * Attribution: countPatchChanges and isVerificationCommand are copied
 * verbatim from RimuruW's fork
 * (~/.pi/agent/git/github.com/RimuruW/pi-advisor/src/advisor-signals.ts).
 */

// ── Attribution: copied from RimuruW/advisor-signals.ts ─────────────────────

/**
 * Count added/removed lines in a unified diff patch.
 * Skips +++ and --- headers.
 */
export function countPatchChanges(patch) {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Detect whether a command is a verification command (tests, lint, build,
 * typecheck).
 */
const VERIFICATION_SEGMENT_PATTERNS = [
  /^(?:npx\s+|bunx\s+)?(?:jest|vitest|pytest|rspec|tsc|eslint|biome|mocha|ava)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|build)\b/,
  /^cargo\s+(?:test|check|clippy|build)\b/,
  /^go\s+(?:test|vet|build)\b/,
  /^make\s+(?:test|check|lint|build)\b/,
  /^node\s+--test\b/,
  /^python3?\s+-m\s+pytest\b/,
];

export function isVerificationCommand(command) {
  if (!command) return false;
  // Match per pipeline segment against the leading token, so paths like
  // `cat tests/foo.test.ts` don't register as verification runs.
  return command.split(/&&|\|\||;|\|/).some((segment) => {
    const normalized = segment.trim().replace(/^(?:\w+=\S+\s+)+/, "");
    return VERIFICATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

// ── Primary: collect changes from tool_result events ────────────────────────

/**
 * Collect changes from the event stream (primary source — has real patches).
 * Aggregates per file: later edits for the same path accumulate +/−.
 */
export function collectChangesFromEvents(events, _diffMode, maxChars) {
  // Aggregate edits + writes by path (later wins for snippets)
  const byPath = new Map();

  for (const evt of events) {
    if (evt.kind === "edit") {
      const stats = countPatchChanges(evt.patch);
      if (stats.added === 0 && stats.removed === 0) continue; // skip no-op patches
      const entry = byPath.get(evt.path) ?? { edits: [], writes: [], bash: [] };
      entry.edits.push({ path: evt.path, ...stats, snippet: "" });
      byPath.set(evt.path, entry);
    } else if (evt.kind === "write") {
      const lines = evt.content.split("\n").length;
      const entry = byPath.get(evt.path) ?? { edits: [], writes: [], bash: [] };
      entry.writes.push({ path: evt.path, added: lines, removed: 0, writtenLines: lines });
      byPath.set(evt.path, entry);
    } else if (evt.kind === "bash") {
      const entry = byPath.get(evt.path) ?? { edits: [], writes: [], bash: [] };
      entry.bash.push(evt);
      byPath.set(evt.path, entry);
    }
  }

  const changes = [];
  for (const [path, entry] of byPath) {
    // Merge all edits for this path
    let totalAdded = 0;
    let totalRemoved = 0;
    let hasWrite = entry.writes.length > 0;
    let latestWrite = entry.writes[entry.writes.length - 1];
    let snippets = [];

    for (const edit of entry.edits) {
      totalAdded += edit.added;
      totalRemoved += edit.removed;
      if (edit.snippet) snippets.push(edit.snippet);
    }

    if (hasWrite) {
      // Write = full replacement, stat shows "rewritten N lines"
      changes.push({
        path,
        added: latestWrite?.writtenLines ?? 0,
        removed: 0,
        writtenLines: latestWrite?.writtenLines,
        snippet: snippets.length > 0 ? snippets[snippets.length - 1] : "",
      });
    } else {
      changes.push({ path, added: totalAdded, removed: totalRemoved, snippet: snippets[snippets.length - 1] ?? "" });
    }
  }

  // Sort by path for deterministic output
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

// ── Fallback: collect changes from branch entries ──────────────────────────

/**
 * Collect changes from the branch entries (fallback when events are missing).
 * Reconstructs +/− from toolCall.arguments.edits[].oldText / .newText.
 * No patch available, so snippets mode shows the newText of the largest edit.
 */
export function collectChangesFromBranch(entries, _diffMode, maxChars) {
  // Walk entries to find assistant toolCall blocks for edit/write/bash
  const byPath = new Map();

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const msg = entry.message;

    // Only look at assistant messages that contain toolCall blocks
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "toolCall" || typeof block.name !== "string") continue;

      const args = block.arguments;
      if (!args) continue;

      if (block.name === "edit") {
        const edits = Array.isArray(args.edits) ? args.edits : [];
        if (args.oldText && args.newText) {
          edits.push({ oldText: args.oldText, newText: args.newText });
        }
        const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "(unknown)";
        let added = 0;
        let removed = 0;
        let largestSnippet = "";

        for (const edit of edits) {
          const oldText = typeof edit?.oldText === "string" ? edit.oldText : "";
          const newText = typeof edit?.newText === "string" ? edit.newText : "";
          added += newText.split("\n").length;
          removed += oldText.split("\n").length;
          // Keep largest edit's newText as snippet
          if (newText.length > largestSnippet.length) {
            largestSnippet = newText.slice(0, 2000); // cap at 2k
          }
        }

        if (added === 0 && removed === 0) continue;
        const entry = byPath.get(path) ?? { edits: [], writes: [], bash: [] };
        entry.edits.push({ path, added, removed, snippet: largestSnippet });
        byPath.set(path, entry);
      } else if (block.name === "write") {
        const content = typeof args.content === "string" ? args.content : "";
        const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "(unknown)";
        const lines = content.split("\n").length;
        const e = byPath.get(path) ?? { edits: [], writes: [], bash: [] };
        e.writes.push({ path, added: lines, removed: 0, writtenLines: lines });
        byPath.set(path, e);
      } else if (block.name === "bash") {
        const command = typeof args.command === "string" ? args.command : "";
        const e = byPath.get("(bash)") ?? { edits: [], writes: [], bash: [] };
        e.bash.push({ kind: "bash", command, isError: false, ts: 0 });
        byPath.set("(bash)", e);
      }
    }
  }

  const changes = [];
  for (const [path, entry] of byPath) {
    // Skip bash-only entries (bash has no path-based aggregation)
    if (entry.edits.length === 0 && entry.writes.length === 0) continue;

    let totalAdded = 0;
    let totalRemoved = 0;
    let hasWrite = entry.writes.length > 0;
    let largestSnippet = "";
    let latestWrite = entry.writes[entry.writes.length - 1];

    for (const edit of entry.edits) {
      totalAdded += edit.added;
      totalRemoved += edit.removed;
      if (edit.snippet && edit.snippet.length > largestSnippet.length) {
        largestSnippet = edit.snippet;
      }
    }

    if (hasWrite) {
      changes.push({
        path,
        added: latestWrite?.writtenLines ?? 0,
        removed: 0,
        writtenLines: latestWrite?.writtenLines,
        snippet: largestSnippet,
      });
    } else {
      changes.push({ path, added: totalAdded, removed: totalRemoved, snippet: largestSnippet });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

// ── Render digests ─────────────────────────────────────────────────────────

/**
 * Render a stat digest: list of changed files with +/- line counts,
 * plus verification commands.
 */
export function renderStatDigest(changes, verifications) {
  const lines = [];
  lines.push("Changed files:");

  for (const c of changes) {
    if (c.writtenLines !== undefined) {
      lines.push(`  ${c.path}  (rewritten, ${c.writtenLines} lines)`);
    } else if (c.added === 0 && c.removed === 0) {
      lines.push(`  ${c.path}  (no net changes)`);
    } else {
      lines.push(`  ${c.path}  +${c.added} /-${c.removed}`);
    }
  }

  if (verifications.length > 0) {
    const verified = verifications.slice(0, 5).map((v) => {
      const trimmed = v.length > 80 ? v.slice(0, 80) + "…" : v;
      return trimmed;
    });
    lines.push(`Verification run: ${verified.join(" || ")}`);
  }

  return lines.join("\n");
}

/**
 * Render a snippets digest: stat header + capped unified hunks per file.
 */
export function renderSnippetsDigest(changes, verifications, maxChars) {
  const parts = [];

  // Header
  let headerLines = ["Changed files:"];
  for (const c of changes) {
    if (c.writtenLines !== undefined) {
      headerLines.push(`  ${c.path}  (rewritten, ${c.writtenLines} lines)`);
    } else {
      headerLines.push(`  ${c.path}  +${c.added} /-${c.removed}`);
    }
  }
  parts.push(headerLines.join("\n"));

  // Verification
  if (verifications.length > 0) {
    const verified = verifications.slice(0, 5).map((v) => {
      const trimmed = v.length > 80 ? v.slice(0, 80) + "…" : v;
      return trimmed;
    });
    parts.push(`Verification run: ${verified.join(" || ")}`);
  }

  // Snippets (if provided)
  for (const c of changes) {
    if (c.snippet && c.snippet.length > 0) {
      const snippetSection = `\n--- ${c.path}\n${c.snippet}`;
      const currentLen = parts.join("\n\n").length + snippetSection.length;
      if (currentLen <= maxChars) {
        parts.push(snippetSection);
      } else {
        // Truncate remaining budget
        const remaining = maxChars - parts.join("\n\n").length - 4; // "[digest truncated]"
        if (remaining > 20) {
          parts.push(`--- ${c.path}\n${c.snippet.slice(0, remaining)}…`);
        }
        break; // stop adding snippets once we're over budget
      }
    }
  }

  const result = parts.join("\n\n");
  if (result.length > maxChars) {
    return result.slice(0, maxChars) + "\n…[digest truncated]";
  }
  return result;
}

// ── Public API: renderDigest ────────────────────────────────────────────────

export function renderDigest(changes, verifications, diffMode, maxChars) {
  switch (diffMode) {
    case "stat":
    case "git-stat":
      return renderStatDigest(changes, verifications);
    case "snippets":
    case "git-snippets":
      return renderSnippetsDigest(changes, verifications, maxChars);
    case "none":
    default:
      return "";
  }
}

// ── Opt-in: git subprocess modes ────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `git diff` and parse into a FileChange[] for stat mode,
 * or return the raw diff for snippets mode.
 *
 * Only when projectTrusted. Returns null on failure (non-git dir, no HEAD, etc.)
 * so the caller can fall back to transcript harvest.
 */
export async function collectChangesFromGit(cwd, mode, maxChars, projectTrusted) {
  if (!projectTrusted) {
    return null;
  }

  try {
    if (mode === "git-stat") {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", "--no-color", "--", "."], {
        cwd,
        timeout: 5000,
        maxBuffer: maxChars,
      });

      const changes = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        // git --stat format: " path | N +++  / N ---  / N +++++/-----"
        const match = line.match(/^(\s*)(.+?)\s*\|\s*(\d+)\s*([\+−\-]+)?\s*([\+−\-]*)?\s*$/);
        if (match) {
          const p = match[2].trim();
          changes.push({ path: p, added: (match[4] ?? "").length, removed: (match[5] ?? "").length });
        }
      }

      return { changes, verifications: [] };
    } else {
      // git-snippets: raw diff
      const { stdout } = await execFileAsync("git", ["diff", "--no-color"], {
        cwd,
        timeout: 10000,
        maxBuffer: maxChars,
      });

      // Parse raw diff into changes
      const changes = [];
      let currentPath = "";
      const lines = stdout.split("\n");
      let i = 0;
      while (i < lines.length) {
        // Match --- a/path or +++ b/path lines
        const headerMatch = lines[i].match(/^---\s+a\/?(.+?)$|^diff\-\-\-\s+a\/?(.+?)$/);
        if (headerMatch) {
          currentPath = headerMatch[1] ?? headerMatch[2] ?? "";
          i++;
          continue;
        }
        const plusPlusPlusMatch = lines[i].match(/^\+\+\+\s+b\/?(.+?)$/);
        if (plusPlusPlusMatch && currentPath) {
          currentPath = plusPlusPlusMatch[1] ?? currentPath;
        }
        i++;
      }

      if (!currentPath && stdout.trim()) {
        // Fallback: couldn't parse, return as-is in a synthetic entry
        const stats = countPatchChanges(stdout);
        changes.push({
          path: "(git diff output)",
          added: stats.added,
          removed: stats.removed,
          snippet: stdout.slice(0, maxChars),
        });
      }

      return { changes, verifications: [] };
    }
  } catch (err) {
    // Non-git dir, no HEAD, empty tree — silently return null
    return null;
  }
}
