/**
 * Timestamp Extension
 *
 * Displays timestamps for user input and agent completion timing.
 * All timestamps are display-only — they never enter the LLM context.
 *
 * - Shows `[Sent HH:MM:SS]` after each user message
 * - Shows `Done at HH:MM:SS · duration` after each agent turn
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSecs = ms / 1000;
    if (totalSecs < 60) return `${totalSecs.toFixed(1)}s`;
    const totalMins = totalSecs / 60;
    if (totalMins < 60) {
        const m = Math.floor(totalMins);
        const s = (totalSecs % 60).toFixed(1);
        return `${m}m ${s}s`;
    }
    const hrs = totalMins / 60;
    return `${Math.floor(hrs)}h ${Math.floor(totalMins % 60)}m`;
}

export default function (pi: ExtensionAPI) {
    let taskStartTime: number | undefined;

    // Track when the agent starts processing (first turn of this prompt)
    pi.on("agent_start", async (_event, _ctx) => {
        taskStartTime = Date.now();
    });

    // Show "Sent HH:MM:SS" after each user message
    pi.on("message_end", async (event, _ctx) => {
        if (event.message.role !== "user") return;

        const ts = event.message.timestamp;
        if (!ts) return;

        pi.sendMessage({
            customType: "timestamp",
            content: `Sent ${formatTime(ts)}`,
            display: true,
        }, { triggerTurn: false });
    });

    // Show completion timing after agent finishes
    pi.on("agent_end", async (_event, _ctx) => {
        const startTime = taskStartTime;
        taskStartTime = undefined;

        if (startTime === undefined) return;

        const endTime = Date.now();
        const duration = endTime - startTime;

        pi.sendMessage({
            customType: "timestamp",
            content: `Done at ${formatTime(endTime)} · ${formatDuration(duration)}`,
            display: true,
        }, { triggerTurn: false });
    });

    // Render all timestamp lines in a muted/dim style
    pi.registerMessageRenderer("timestamp", (message, _options, theme) => {
        const text = typeof message.content === "string" ? message.content : "";
        return new Text(theme.fg("dim", text), 0, 0);
    });
}
