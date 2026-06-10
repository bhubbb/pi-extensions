import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "Disable extended thinking",
  minimal: "Use the smallest available thinking budget",
  low: "Light reasoning",
  medium: "Balanced default reasoning",
  high: "More reasoning for harder tasks",
  xhigh: "Maximum reasoning budget",
};

function normalizeThinkingLevel(input: string): ThinkingLevel | undefined {
  const normalized = input.toLowerCase().trim();
  return THINKING_LEVELS.find((level) => level === normalized);
}

function getThinkingLevelCompletions(prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.toLowerCase().trimStart();
  const matches = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix));

  if (matches.length === 0) return null;

  return matches.map((level) => ({
    value: level,
    label: level,
    description: THINKING_LEVEL_DESCRIPTIONS[level],
  }));
}

export default function thinkingShortcutExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("thinking", `level: ${pi.getThinkingLevel()}`);

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/^\/thinking\s+(\S*)$/);

        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const prefix = match[1] ?? "";
        const items = getThinkingLevelCompletions(prefix);
        return items ? { prefix, items } : null;
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        if (/^\/thinking\s+\S*$/.test(beforeCursor)) return false;
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    ctx.ui.setStatus("thinking", `level: ${event.level}`);
  });

  pi.registerCommand("thinking", {
    description: "Set the thinking level. Usage: /thinking [off|minimal|low|medium|high|xhigh]",
    getArgumentCompletions: getThinkingLevelCompletions,
    handler: async (args, ctx) => {
      const input = args?.trim() || "medium";
      const level = normalizeThinkingLevel(input);

      if (!level) {
        ctx.ui.notify(
          `Invalid level: "${input}". Valid options are: ${THINKING_LEVELS.join(", ")}.`,
          "error",
        );
        return;
      }

      pi.setThinkingLevel(level);

      ctx.ui.notify(`Thinking level set to: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
