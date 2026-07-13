/**
 * context-policy.ts — tail selection, rendering with strip/keep, payload assembly.
 *
 * Pure module: no pi imports. Reuses patterns from upstream
 * hknet/pi-extensions and github.com/RimuruW/pi-advisor.
 */

/** @deprecated — AnyEntry is an upstream-compatible shape defined locally. */
type AnyEntry = { type?: string; message?: any };
import type { ContextMode, KeepToolResults } from "./config.ts";
import type { Model, Api } from "@earendil-works/pi-ai";

// ── Re-export AnyEntry from upstream-compatible shape ─────────────────────────
// Entries are { type?: string; message?: any } where message has:
//   role: "user" | "assistant" | "toolResult"
//   content: TextContent | ImageContent | Array<{type, text, ...}>
//   toolName, isError (for toolResult)

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_TOOL_CALL_ARGS_CHARS = 800;
const MAX_TOOL_RESULT_CHARS = 2000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: unknown): b is { type: string; text: string } =>
      Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

// ── Render a single entry (adapted from upstream renderEntry) ─────────────────

type RenderOpts = {
  stripReasoning: boolean;
  keepToolResults: KeepToolResults;
  skipToolResult?: boolean; // for tail selection logic
};

function renderEntry(entry: AnyEntry, opts: RenderOpts): string | null {
  if (entry.type !== "message" || !entry.message?.role) return null;
  const msg = entry.message;

  if (msg.role === "user") {
    const t = textOf(msg.content).trim();
    return t ? `## User\n${t}` : null;
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        if (!opts.stripReasoning) {
          parts.push(`[reasoning]\n${b.thinking.trim()}`);
        }
        // If stripReasoning, skip entirely
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      } else if (b.type === "toolCall" && typeof b.name === "string") {
        parts.push(`→ called \`${b.name}\`(${truncate(JSON.stringify(b.arguments ?? {}), MAX_TOOL_CALL_ARGS_CHARS)})`);
      }
    }
    return parts.length ? `## Assistant\n${parts.join("\n\n")}` : null;
  }

  if (msg.role === "toolResult") {
    // In "tail" mode with keepToolResults="none", skip rendering
    if (opts.skipToolResult && opts.keepToolResults === "none") return null;
    const flag = msg.isError ? " (error)" : "";
    const body = truncate(textOf(msg.content).trim(), MAX_TOOL_RESULT_CHARS);
    return `### Result of \`${msg.toolName}\`${flag}\n${body || "(no output)"}`;
  }

  return null;
}

// ── Tail selection (D1: keep first user + last N) ────────────────────────────

/**
 * Select message entries: always keep first user message + last N entries.
 * Inserts an omitted marker at the cut.
 *
 * Returns the selected entries (not rendered).
 */
export function selectTail(
  entries: AnyEntry[],
  tailMessages: number,
): { selected: AnyEntry[]; omittedMarker: string } {
  // Count message entries
  const messageEntries = entries.filter((e) => e.type === "message" && e.message?.role);
  if (messageEntries.length === 0) {
    return { selected: [], omittedMarker: "" };
  }

  // Always keep the first user message (task framing)
  const firstUserIdx = messageEntries.findIndex((e) => {
    const msg = e.message;
    return msg && msg.role === "user";
  });

  const keepFirstCount = firstUserIdx >= 0 ? 1 : 0;
  const keepLastCount = Math.min(tailMessages - keepFirstCount, messageEntries.length - keepFirstCount);

  if (keepFirstCount + keepLastCount >= messageEntries.length) {
    // All entries fit — no truncation needed
    const selected = entries.filter((e) => messageEntries.includes(e));
    return { selected, omittedMarker: "" };
  }

  const omittedCount = messageEntries.length - keepFirstCount - keepLastCount;
  const omittedMarker = `[${omittedCount} earlier messages omitted]`;

  // Get first user + last N entries from the full entries array
  const firstEntry = entries.find((e) => e.type === "message" && e.message?.role === "user");
  const tailEntries = messageEntries.slice(-keepLastCount);

  const selected = [
    ...(firstEntry ? [firstEntry] : []),
    ...tailEntries,
  ];

  return { selected, omittedMarker };
}

// ── Full transcript render (for "full" mode) ──────────────────────────────────

/**
 * Render the full branch transcript (oldest-first).
 * Same as upstream buildTranscript but with stripReasoning support.
 */
function renderFullTranscript(entries: AnyEntry[], stripReasoning: boolean): string {
  const sections: string[] = [];
  for (const e of entries) {
    const r = renderEntry(e, { stripReasoning, keepToolResults: "all", skipToolResult: false });
    if (r) sections.push(r);
  }
  return sections.join("\n\n");
}

// ── Tail transcript render ────────────────────────────────────────────────────

/**
 * Render a tail-mode transcript: first user + omitted marker + tail entries.
 * ToolResults are filtered by keepToolResults policy.
 */
function renderTailTranscript(
  entries: AnyEntry[],
  tailMessages: number,
  stripReasoning: boolean,
  keepToolResults: KeepToolResults,
): string {
  const { selected, omittedMarker } = selectTail(entries, tailMessages);
  const sections: string[] = [];

  if (omittedMarker) {
    sections.push(omittedMarker);
  }

  // For keepToolResults="recent", only render toolResults whose preceding
  // assistant message is within the tail window.
  const messageOnly = selected.filter((e) => e.type === "message" && e.message?.role);
  const msgRoles = new Set(messageOnly.map((e) => e.message.role));

  // If keepToolResults is not "all", we need to be selective.
  // "recent" = only toolResults after the kept window boundary
  // "all" = render everything
  // "none" = skip all

  // Build a simple index to track position
  const keepAll = keepToolResults === "all";
  // For "recent", we render all toolResults in the selected set
  // (they're already within the tail window)
  const skipNone = keepToolResults === "none";

  for (const e of selected) {
    const r = renderEntry(e, {
      stripReasoning,
      keepToolResults,
      skipToolResult: skipNone,
    });
    if (r) sections.push(r);
  }

  return sections.join("\n\n");
}

// ── Summary payload helpers ───────────────────────────────────────────────────

/** Render just the last 2-3 messages for "summary" mode. */
function renderLastFew(entries: AnyEntry[], count: number, stripReasoning: boolean): string {
  const messageOnly = entries.filter((e) => e.type === "message" && e.message?.role);
  const last = messageOnly.slice(-count);
  const sections: string[] = [];
  for (const e of last) {
    const r = renderEntry(e, { stripReasoning, keepToolResults: "all", skipToolResult: false });
    if (r) sections.push(r);
  }
  return sections.join("\n\n");
}

// ── Overflow trim (oldest-first) ─────────────────────────────────────────────

/**
 * Trim oldest sections first to fit within the reviewer's context window.
 * Reuses upstream charBudget math.
 */
function trimToContext(transcript: string, model: Pick<Model<Api>, "maxTokens" | "contextWindow">): string {
  if (!transcript) return transcript;

  const reserveTokens = (model.maxTokens ?? 4096) + 2000;
  const usableTokens = Math.max(4000, (model.contextWindow ?? 128000) - reserveTokens);
  const charBudget = Math.floor(usableTokens * 3.5);

  if (transcript.length <= charBudget) return transcript;

  // Trim from the beginning, keeping a header note
  const trimmed = transcript.slice(0, charBudget);
  const dropped = transcript.length - charBudget;
  return `[Note: transcript trimmed (approx ${dropped} chars removed from the beginning to fit the reviewer's context window).]\n\n${trimmed}`;
}

// ── Payload assembly (the main function) ──────────────────────────────────────

type BuildPayloadOpts = {
  tailMessages: number;
  stripReasoning: boolean;
  keepToolResults: KeepToolResults;
  diffDigest: string;         // pre-rendered by diff.ts ("") if diffMode none
  summary?: string;           // pre-generated (undefined if summary failed — D3)
};

/**
 * Build the advisor payload for the given context mode.
 *
 * @param entries — the session branch entries
 * @param mode — which context mode to use
 * @param opts — rendering options + pre-computed digest/summary
 * @param model — reviewer model (for overflow trim)
 * @returns the assembled transcript string (non-empty or "")
 */
export function buildAdvisorPayload(
  entries: AnyEntry[],
  mode: ContextMode,
  opts: BuildPayloadOpts,
  model: Pick<Model<Api>, "maxTokens" | "contextWindow">,
): string {
  let body = "";

  switch (mode) {
    case "full": {
      // Full transcript, reasoning-stripped. No digest/summary.
      body = renderFullTranscript(entries, opts.stripReasoning);
      break;
    }

    case "tail": {
      // Task framing + omitted marker + tail + diff digest
      const tailText = renderTailTranscript(entries, opts.tailMessages, opts.stripReasoning, opts.keepToolResults);
      body = tailText;
      if (opts.diffDigest) {
        body += `\n\n[Changed files]\n${opts.diffDigest}`;
      }
      break;
    }

    case "summary": {
      // Summary + diff digest + last 2-3 messages
      if (opts.summary !== undefined) {
        body = `[Summary]\n${opts.summary}\n\n[Changed files]\n${opts.diffDigest}\n\n[Last messages]\n${renderLastFew(entries, 3, opts.stripReasoning)}`;
      } else {
        // D3 fallback: summary failed → degrade to tail shape
        const tailText = renderTailTranscript(entries, opts.tailMessages, opts.stripReasoning, opts.keepToolResults);
        body = `[summary unavailable — showing recent transcript]\n\n${tailText}`;
        if (opts.diffDigest) {
          body += `\n\n[Changed files]\n${opts.diffDigest}`;
        }
      }
      break;
    }

    case "summary+tail": {
      // Summary + diff digest + last N messages
      if (opts.summary !== undefined) {
        const tailText = renderTailTranscript(entries, opts.tailMessages, opts.stripReasoning, opts.keepToolResults);
        body = `[Summary]\n${opts.summary}\n\n[Changed files]\n${opts.diffDigest}\n\n[Recent transcript]\n${tailText}`;
      } else {
        // D3 fallback
        const tailText = renderTailTranscript(entries, opts.tailMessages, opts.stripReasoning, opts.keepToolResults);
        body = `[summary unavailable — showing recent transcript]\n\n${tailText}`;
        if (opts.diffDigest) {
          body += `\n\n[Changed files]\n${opts.diffDigest}`;
        }
      }
      break;
    }
  }

  // Final overflow pass (all modes)
  body = trimToContext(body, model);

  return body;
}
