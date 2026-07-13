/**
 * summarizer.ts — summary pre-call + rolling cache.
 *
 * Thin I/O module: uses complete() from @earendil-works/pi-ai/compat.
 * Pure in spirit (no pi internals), but needs model registry + complete().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Model, Api } from "@earendil-works/pi-ai";
/** AnyEntry shape: upstream-compatible session branch entries. */
type AnyEntryLocal = { type?: string; message?: any };

// ── Cache shape ───────────────────────────────────────────────────────────────

export type SummaryCache = { text: string; branchLen: number } | null;

// ── Summary prompt ────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You are a concise summarizer for an AI coding agent's reviewer.

Given the agent's working transcript, produce a brief summary (max ~10 lines, plain text) covering:
1. The user's original task / goal.
2. What the agent has done so far (key file changes, approaches tried).
3. Current state — what's working, what's open, what's unverified.
4. What's blocking or needs attention.

Be specific and concrete. Name files and functions where relevant. No fluff.`;

const SUMMARY_USER_PREFIX = `Summarize for a reviewer model, concisely: (1) the user's task, (2) what the agent has done so far, (3) current state / open questions, (4) what's blocking or unverified. Max ~10 lines. Plain text.\n\n`;

// ── Compress entries for the summarizer input ─────────────────────────────────

/**
 * Compress entries into a small text payload for the summarizer to digest.
 * Strips reasoning, shows tool calls as one-liners, truncates results.
 */
function compressEntries(entries: AnyEntryLocal[], stripReasoning: boolean): string {
  const parts: string[] = [];
  const MAX_RESULT_CHARS = 300;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const msg = entry.message;

    if (msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          parts.push(`[user] ${block.text.trim().slice(0, 500)}`);
        }
      }
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking" && stripReasoning) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          parts.push(`[assistant] ${block.text.trim().slice(0, 300)}`);
        }
        if (block.type === "toolCall" && typeof block.name === "string") {
          const argsStr = JSON.stringify(block.arguments ?? {});
          parts.push(`[toolCall] → ${block.name}(${argsStr.slice(0, 100)})`);
        }
      }
    } else if (msg.role === "toolResult") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter((b: any): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      parts.push(`[result] ${msg.toolName}: ${text.slice(0, MAX_RESULT_CHARS)}`);
    }
  }

  return parts.join("\n");
}

// ── Model resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a model by spec or "executor" (the currently running model).
 */
async function resolveSummaryModel(
  ctx: ExtensionContext,
  summaryModel: string | null,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | undefined> {
  if (summaryModel === "executor" || summaryModel === null) {
    // Use the currently running (executor) model — already authed
    const model = ctx.model;
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;
    return { model, apiKey: auth.apiKey, headers: auth.headers };
  }

  // Otherwise it's a "provider/id" spec — resolve like the advisor model
  const parsed = summaryModel.indexOf("/") > 0
    ? { provider: summaryModel.slice(0, summaryModel.indexOf("/")), id: summaryModel.slice(summaryModel.indexOf("/") + 1) }
    : undefined;
  if (!parsed) return undefined;

  const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || (!auth.apiKey && !auth.headers)) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

// ── Main function ─────────────────────────────────────────────────────────────

type SummarySource = "cache" | "executor" | "model";

export async function getSummary(
  ctx: ExtensionContext,
  opts: {
    summaryModel: string | null;
    entries: AnyEntryLocal[];
    stripReasoning: boolean;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal | null;
    refreshEvery: number;
    cache: SummaryCache;
    setCache: (c: { text: string; branchLen: number }) => void;
  },
): Promise<{ text: string; source: SummarySource } | { error: string }> {
  // Rolling cache check
  if (opts.cache && opts.refreshEvery > 0) {
    const branchLen = ctx.sessionManager.getBranch().length;
    if (branchLen - opts.cache.branchLen < opts.refreshEvery) {
      return { text: opts.cache.text, source: "cache" };
    }
  }

  // Compress entries for summarizer input
  const compressed = compressEntries(opts.entries, opts.stripReasoning);
  if (!compressed.trim()) {
    return { error: "No content to summarize" };
  }

  // Resolve the model
  const resolved = await resolveSummaryModel(ctx, opts.summaryModel);
  if (!resolved) {
    return { error: "Summary model unavailable" };
  }

  const { model, apiKey, headers } = resolved;

  // Build abort signal: chain to ctx.signal with own timeout
  const timeoutMs = opts.timeoutMs || 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Chain to parent signal if provided
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timeoutId);
      return { error: "Request cancelled" };
    }
    opts.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      controller.abort();
    }, { once: true });
  }

  try {
    const response = await complete(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: SUMMARY_USER_PREFIX + compressed,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        headers,
        signal: controller.signal,
        maxTokens: opts.maxTokens,
        timeoutMs: timeoutMs === 0 ? undefined : timeoutMs,
      },
    );

    // Extract text from response
    const content = Array.isArray(response?.content) ? response.content : [];
    const advice = content
      .filter((c: any): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!advice) {
      return { error: "Summary returned no text" };
    }

    // Update cache
    const branchLen = ctx.sessionManager.getBranch().length;
    opts.setCache({ text: advice, branchLen });

    const source: SummarySource = opts.summaryModel === "executor" || opts.summaryModel === null
      ? "executor"
      : "model";

    return { text: advice, source };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("abort") || msg.includes("cancel")) {
      return { error: `Summary timed out` };
    }
    return { error: `Summary failed: ${msg}` };
  }
}
