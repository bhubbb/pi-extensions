/**
 * Timestamp Extension
 *
 * Displays timestamps for user input and agent completion timing.
 * All timestamps are display-only — they never enter the LLM context.
 *
 * - Shows `[Sent HH:MM:SS]` after each user message (footer status)
 * - Shows `Done at HH:MM:SS · duration` after each agent turn (footer status)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

    // Track when the agent starts processing
    pi.on("agent_start", async (_event, ctx) => {
        taskStartTime = Date.now();
        // Clear any previous completion message
        ctx.ui.setStatus("timestamp", undefined);
    });

    // Show "Sent HH:MM:SS" after each user message
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "user") return;

        const ts = event.message.timestamp;
        if (!ts) return;

        ctx.ui.setStatus("timestamp", ctx.ui.theme.fg("dim", `Sent ${formatTime(ts)}`));
    });

    // Show completion timing after agent finishes
    pi.on("agent_end", async (_event, ctx) => {
        const startTime = taskStartTime;
        taskStartTime = undefined;

        if (startTime === undefined) return;

        const endTime = Date.now();
        const duration = endTime - startTime;

        ctx.ui.setStatus("timestamp", ctx.ui.theme.fg("dim", `Done at ${formatTime(endTime)} · ${formatDuration(duration)}`));
    });
}
