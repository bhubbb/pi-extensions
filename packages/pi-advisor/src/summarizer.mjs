/**
 * src/summarizer.mjs — summary pre-call + rolling cache for the advisor
 * context policy.
 *
 * Thin I/O module that:
 *   1. Compresses the full branch into a small "summary input" (text-only,
 *      tool calls as one-liners, results truncated to ~300 chars).
 *   2. Calls a model (executor or separate `summaryModel`) to generate a
 *      ~10-line issue summary.
 *   3. Caches the result with rolling invalidation (reuse if <N new messages
 *      since last generation).
 *   4. On failure (timeout, auth error, empty response): returns `{ error }`
 *      instead of throwing — the caller (D3) falls back to tail mode.
 *
 * Uses a separate `AbortController` with `summaryTimeoutMs` so a slow
 * summarizer can't eat the advisor's budget.
 */

import { complete } from "@earendil-works/pi-ai/compat";

// ── Types ───────────────────────────────────────────────────────────────────

/** Result of a summary attempt. */
// @ts-ignore - runtime type
export const SummarySource = { CACHE: "cache", EXECUTOR: "executor", MODEL: "model" };

/** Rolling cache state, passed in/out from advisor.ts closure. */
// @ts-ignore - runtime type
export const SummaryCache = {};

// ── Summary prompt ──────────────────────────────────────────────────────────

const SUMMARY_PROMPT = `Summarize for a reviewer model, concisely:
(1) the user's task
(2) what the agent has done so far
(3) current state / open questions
(4) what's blocking or unverified

Max ~10 lines. Plain text only.`;

// ── Compress entries for summarizer input ───────────────────────────────────

/**
 * Produce a "compressed full render" suitable as input to the summary
 * pre-call. Much smaller than a full transcript:
 *   • text-only (no reasoning)
 *   • tool calls as one-liners
 *   • tool results truncated to ~300 chars
 */
function compressEntriesForSummary(entries, stripReasoning) {
  const sections = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const msg = entry.message;

    if (msg.role === "user") {
      const t = textOf(msg.content).trim();
      if (t) sections.push(`## User\n${t}`);
    } else if (msg.role === "assistant") {
      const parts = [];
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "thinking" && stripReasoning) continue; // skip reasoning
        if (b.type === "thinking" && typeof b.thinking === "string") {
          parts.push(`[reasoning]\n${b.thinking.slice(0, 200)}…`);
        } else if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text.trim());
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const args = b.arguments ? JSON.stringify(b.arguments) : "{}";
          parts.push(`→ ${b.name}(${args.slice(0, 100)})`);
        }
      }
      if (parts.length) sections.push(`## Assistant\n${parts.join("\n\n")}`);
    } else if (msg.role === "toolResult") {
      const flag = msg.isError ? " (error)" : "";
      const body = textOf(msg.content).trim().slice(0, 300);
      sections.push(`### Result of ${msg.toolName}${flag}\n${body || "(no output)"}`);
    }
  }

  return sections.join("\n\n");
}

// ── Text helpers ────────────────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// ── Model resolution ────────────────────────────────────────────────────────

/**
 * Parse a model spec "provider/id" into parts.
 * Copied from upstream advisor.ts.
 */
function parseSpec(spec) {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/**
 * Resolve a model spec to a Model object with auth.
 * Copied from upstream advisor.ts.
 */
async function tryModel(ctx, spec) {
  const parsed = parseSpec(spec);
  if (!parsed) return undefined;
  const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || (!auth.apiKey && !auth.headers)) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getSummary(
  ctx,
  opts,
) {
  const {
    summaryModel,
    entries,
    stripReasoning,
    maxTokens,
    timeoutMs,
    signal: parentSignal,
    refreshEvery,
    cache,
    setCache,
  } = opts;

  // ── Rolling cache check ──
  if (cache && refreshEvery > 0) {
    const branchLen = entries.length;
    const grow = branchLen - cache.branchLen;
    if (grow < refreshEvery) {
      // Still within the refresh window — reuse cached summary
      return { text: cache.text, source: SummarySource.CACHE };
    }
  }

  // ── Resolve model ──
  let modelInfo;

  if (summaryModel === "executor" || summaryModel === null) {
    // Use the running (executor) model — already authed
    modelInfo = { model: ctx.model };
  } else {
    // Resolve a separate summary model spec
    const hit = await tryModel(ctx, summaryModel);
    if (!hit) {
      return { error: `summaryModel "${summaryModel}" not configured or lacks auth` };
    }
    modelInfo = hit;
  }

  // ── Compress input ──
  const compressed = compressEntriesForSummary(entries, stripReasoning);
  if (!compressed.trim()) {
    return { error: "no entries to summarize" };
  }

  // ── Create a separate AbortController so the summary call can't hang the
  //    advisor budget. Chain to parent signal for cancellation. ──
  const abortCtl = new AbortController();
  const timer = setTimeout(() => abortCtl.abort(), timeoutMs);

  // Propagate parent cancellation
  if (parentSignal) {
    if (parentSignal.aborted) abortCtl.abort();
    else parentSignal.addEventListener("abort", () => abortCtl.abort(), { once: true });
  }

  try {
    const response = await complete(
      modelInfo.model,
      {
        systemPrompt: SUMMARY_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Here is the working transcript so far. Summarize it:\n\n${compressed}`,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: modelInfo.apiKey,
        headers: modelInfo.headers,
        signal: abortCtl.signal,
        maxTokens,
        timeoutMs: timeoutMs === 0 ? undefined : timeoutMs,
      },
    );

    // Extract text from response
    const content = Array.isArray(response?.content) ? response.content : [];
    const advice = content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!advice) {
      return { error: "advisor returned no visible text" };
    }

    // Cache the result
    const newCache = {
      text: advice,
      branchLen: entries.length,
    };
    setCache(newCache);

    const source = summaryModel === "executor" || summaryModel === null ? SummarySource.EXECUTOR : SummarySource.MODEL;
    return { text: advice, source };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `summary pre-call failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
