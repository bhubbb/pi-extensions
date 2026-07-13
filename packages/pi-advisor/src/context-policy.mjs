/**
 * src/context-policy.mjs — tail selection and payload assembly for the
 * advisor context policy.
 *
 * Pure module (Node builtins only) so it is unit-testable with `node --test`.
 *
 * Reuses hknet's renderEntry/truncate/textOf pattern from advisor.ts, but
 * adds:
 *   • stripReasoning — drop assistant "thinking" blocks before rendering
 *   • keepToolResults  — control toolResult rendering within the tail window
 *
 * Two exported functions:
 *   1. selectTail       — keep first user msg + last N entries + omitted marker
 *   2. buildAdvisorPayload — assemble the final transcript string per mode
 */

// ── Constants (from upstream advisor.ts) ────────────────────────────────────

const MAX_TOOL_CALL_ARGS_CHARS = 800;
const MAX_TOOL_RESULT_CHARS = 2000;

// ── Text helpers ────────────────────────────────────────────────────────────

export function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// ── Entry rendering ─────────────────────────────────────────────────────────

/**
 * Render a single branch entry to a text section.
 * @param stripReasoning — when true, skip "thinking" blocks in assistant entries
 * @param showToolResults — when true, render toolResult entries; when false, skip them
 */
export function renderEntry(entry, opts) {
  if (entry.type !== "message" || !entry.message?.role) return null;
  const msg = entry.message;

  if (msg.role === "user") {
    const t = textOf(msg.content).trim();
    return t ? `## User\n${t}` : null;
  }

  if (msg.role === "assistant") {
    const parts = [];
    const showReasoning = !(opts?.stripReasoning ?? true);

    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        if (showReasoning) {
          parts.push(`[reasoning]\n${b.thinking.trim()}`);
        }
        // else: skip thinking blocks entirely
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      } else if (b.type === "toolCall" && typeof b.name === "string") {
        parts.push(`→ called \`${b.name}\`(${truncate(JSON.stringify(b.arguments ?? {}), MAX_TOOL_CALL_ARGS_CHARS)})`);
      }
    }
    return parts.length ? `## Assistant\n${parts.join("\n\n")}` : null;
  }

  if (msg.role === "toolResult") {
    // skip toolResults unless explicitly asked (keepToolResults logic handles this)
    if (!opts?.showToolResults) return null;
    const flag = msg.isError ? " (error)" : "";
    const body = truncate(textOf(msg.content).trim(), MAX_TOOL_RESULT_CHARS);
    return `### Result of \`${msg.toolName}\`${flag}\n${body || "(no output)"}`;
  }

  return null;
}

// ── Tail selection ──────────────────────────────────────────────────────────

/**
 * Select the last `tailMessages` message entries, always keeping the first
 * user message (task framing). Returns the full entry list (not just rendered
 * text) so the caller can render with the desired options.
 *
 * Always keeps:
 *   • First user message (re-inserted at the front if it falls outside the window)
 *   • Last `tailMessages` entries
 *
 * Inserts an "[… N earlier messages omitted …]" marker at the cut point.
 */
export function selectTail(entries, tailMessages) {
  // Count only message-type entries
  const messageEntries = [];
  for (const e of entries) {
    if (e.type === "message" && e.message?.role) {
      messageEntries.push(e);
    }
  }

  if (messageEntries.length <= tailMessages) {
    // No truncation needed — all entries fit
    return { kept: messageEntries, omittedCount: 0, firstUserReInserted: false };
  }

  const firstEntry = messageEntries[0];
  const firstUserIdx = messageEntries.findIndex((e) => e.message?.role === "user");
  const firstUserEntry = firstUserIdx >= 0 ? messageEntries[firstUserIdx] : firstEntry;

  // We need to keep:
  //   1. The first user message (task framing) — even if it falls outside the window
  //   2. The last `tailMessages` entries
  //
  // Strategy: collect the first user entry (if not already in the last N),
  // then take the last N entries, deduplicate, and insert an omitted marker.

  const lastNStart = Math.max(0, messageEntries.length - tailMessages);
  const lastNEntries = messageEntries.slice(lastNStart);

  let firstUserReInserted = false;
  let keptSet = new Set(lastNEntries);

  // If the first user entry is not in the last N, we need to re-insert it
  if (!keptSet.has(firstUserEntry)) {
    keptSet = new Set([firstUserEntry, ...lastNEntries]);
    firstUserReInserted = true;
  }

  // Reconstruct: first user + omitted marker + last N (minus first user)
  const kept = [];
  const omittedCount = messageEntries.length - lastNEntries.length;

  if (firstUserReInserted) {
    kept.push(firstUserEntry);
  }

  // Build a filtered list of last N without the first user (avoiding duplicate)
  const tailOnly = lastNEntries.filter((e) => !keptSet.has(firstUserEntry) || e !== firstUserEntry);

  return {
    kept: firstUserReInserted ? [firstUserEntry, ...tailOnly] : tailOnly,
    omittedCount,
    firstUserReInserted,
  };
}

// ── Build toolResult awareness map ──────────────────────────────────────────

/**
 * Build a set of "assistant indices" that have toolCall blocks.
 * Used by keepToolResults="recent" to only show toolResults whose preceding
 * assistant is inside the tail window.
 */
function toolCallOwnerIndices(entries) {
  const owners = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "message" && e.message?.role === "assistant") {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      if (content.some((b) => b?.type === "toolCall")) {
        owners.add(i);
      }
    }
  }
  return owners;
}

// ── Overflow trimming ───────────────────────────────────────────────────────

/**
 * Oldest-first char-budget trim. Returns a new entries list.
 * Reuses hknet's reserveTokens/usableTokens/charBudget math.
 */
function oldestFirstTrim(entries, model) {
  if (entries.length <= 1) return entries;

  const reserveTokens = (model.maxTokens ?? 4096) + 2000;
  const usableTokens = Math.max(4000, (model.contextWindow ?? 128000) - reserveTokens);
  const charBudget = Math.floor(usableTokens * 3.5);

  // Render all sections and measure total
  const sections = [];
  for (const e of entries) {
    const r = renderEntry(e, { stripReasoning: true, showToolResults: true });
    if (r) sections.push({ entry: e, text: r });
  }

  let total = sections.reduce((n, s) => n + s.text.length + 2, 0);
  let dropped = 0;

  while (total > charBudget && sections.length > 1) {
    total -= sections.shift().text.length + 2;
    dropped++;
  }

  if (dropped > 0 && dropped < entries.length) {
    // Insert omitted marker at the position where we dropped
    const marker = {
      type: "message",
      message: {
        role: "user",
        content: `[${dropped} earlier section(s) omitted for brevity]`,
      },
    };
    return [marker, ...sections.map((s) => s.entry)];
  }

  return sections.map((s) => s.entry);
}

// ── Mode assembly ───────────────────────────────────────────────────────────

function renderAll(entriesList, includeToolResults, stripReasoning, keepToolResults) {
  const sections = [];
  for (const e of entriesList) {
    const r = renderEntry(e, {
      stripReasoning: stripReasoning,
      showToolResults: includeToolResults,
    });
    if (r) sections.push(r);
  }
  return sections;
}

function renderRecentToolResults(entries, stripReasoning, keepToolResults) {
  if (keepToolResults !== "recent") {
    return renderAll(entries, keepToolResults === "all", stripReasoning, keepToolResults);
  }

  const toolCallOwners = toolCallOwnerIndices(entries);
  const sections = [];
  for (const e of entries) {
    const r = renderEntry(e, {
      stripReasoning: stripReasoning,
      showToolResults: true,
    });
    if (r === null) continue;
    if (e.message?.role === "toolResult") {
      // Only show if the preceding assistant is in the tail window
      const idx = entries.indexOf(e);
      let hasRecentToolCall = false;
      for (let j = idx - 1; j >= 0; j--) {
        if (entries[j].type === "message" && entries[j].message?.role === "assistant") {
          hasRecentToolCall = toolCallOwners.has(j);
          break;
        }
      }
      if (hasRecentToolCall) sections.push(r);
    } else {
      sections.push(r);
    }
  }
  return sections;
}

export function buildAdvisorPayload(
  entries,
  mode,
  opts,
  model,
) {
  // ── full ── (traditional upstream behavior, with optional stripReasoning) ──
  if (mode === "full") {
    const sections = renderAll(entries, true, opts.stripReasoning, opts.keepToolResults);
    if (sections.length === 0) return "";

    const trimmed = oldestFirstTrim(entries, model);
    return renderAll(trimmed, true, opts.stripReasoning, opts.keepToolResults).join("\n\n");
  }

  // ── tail ── (task framing + last N msgs + diff digest) ──
  if (mode === "tail") {
    const { kept, omittedCount, firstUserReInserted } = selectTail(entries, opts.tailMessages);
    const tailSections = renderRecentToolResults(kept, opts.stripReasoning, opts.keepToolResults);

    const body =
      (firstUserReInserted && omittedCount > 0
        ? `[… ${omittedCount} earlier messages omitted …]\n\n`
        : "") +
      tailSections.join("\n\n");

    // Append diff digest
    if (opts.diffDigest) {
      return `${body}\n\n[Changed files]\n${opts.diffDigest}`;
    }
    return body;
  }

  // ── summary ── (summary + diff + last 2-3 msgs, or degrade to tail) ──
  if (mode === "summary") {
    if (!opts.summary) {
      // D3 fallback: summary unavailable → behave as tail
      return (
        "[summary unavailable — showing recent transcript]\n\n" +
        buildAdvisorPayload(entries, "tail", opts, model)
      );
    }

    const lastN = entries.slice(-3);
    const lastSections = renderRecentToolResults(lastN, opts.stripReasoning, opts.keepToolResults);

    return `[Summary]\n${opts.summary}\n\n[Changed files]\n${opts.diffDigest}\n\n[Last messages]\n${lastSections.join("\n\n")}`;
  }

  // ── summary+tail ── (summary + diff + last N msgs, or degrade to tail) ──
  if (mode === "summary+tail") {
    if (!opts.summary) {
      // D3 fallback: summary unavailable → behave as tail
      return (
        "[summary unavailable — showing recent transcript]\n\n" +
        buildAdvisorPayload(entries, "tail", opts, model)
      );
    }

    const { kept, omittedCount, firstUserReInserted } = selectTail(entries, opts.tailMessages);
    const tailSections = renderRecentToolResults(kept, opts.stripReasoning, opts.keepToolResults);

    const tailBody =
      (firstUserReInserted && omittedCount > 0
        ? `[… ${omittedCount} earlier messages omitted …]\n\n`
        : "") +
      tailSections.join("\n\n");

    return `[Summary]\n${opts.summary}\n\n[Changed files]\n${opts.diffDigest}\n\n[Recent transcript]\n${tailBody}`;
  }

  // Should never reach here
  return "";
}
