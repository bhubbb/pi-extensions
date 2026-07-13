/**
 * StatsView — overlay component that displays llama.cpp server stats.
 *
 * Uses recursive setTimeout (not setInterval) to avoid request stacking
 * when server response time exceeds the refresh interval.
 * Aborts all in-flight fetches when closed.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { StatsBackend } from "./config";
import type { BackendStats, PropsStats, SlotStats, ModelStats, MetricsStats } from "./stats";
import { fetchBackendStats } from "./stats";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh interval (ms). */
const REFRESH_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class StatsView implements Component {
  private backends: StatsBackend[];
  private theme: Theme;
  private tui: TUI;
  private _onDone: () => void;

  // Data
  private stats: BackendStats[] = [];
  private width: number | null = null;

  // Scroll
  private scrollOffset = 0;
  private scrollMax = 0;

  // AbortController — aborts all in-flight fetches when the view is closed.
  private abortController: AbortController | null = null;

  // Recursive refresh timer — not setInterval, so we won't stack requests.
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // In-flight guard — prevents triggering a new fetch while one is already running.
  private isFetching = false;

  constructor(backends: StatsBackend[], theme: Theme, tui: TUI, onDone: () => void) {
    this.backends = backends;
    this.theme = theme;
    this.tui = tui;
    this._onDone = onDone;

    // Create the abort controller that lives for the lifetime of this view.
    this.abortController = new AbortController();

    // Initial fetch + start refresh loop.
    this.scheduleRefresh();
  }

  /**
   * Replace the done callback (called by the overlay wrapper to inject a safety net).
   * The wrapper calls dispose() before the original done, ensuring cleanup even if
   * the overlay is closed by an external path that bypasses handleInput.
   */
  onWrappedDone(wrapped: () => void): void {
    this._onDone = wrapped;
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  render(width: number): string[] {
    this.width = width;
    const lines = this.renderAll(width);

    // Adjust scroll bounds.
    const availableHeight = width / 2; // Rough heuristic — overlay height ~ half width
    this.scrollMax = Math.max(0, lines.length - Math.floor(availableHeight));
    this.scrollOffset = Math.min(this.scrollOffset, this.scrollMax);

    // Slice for scrolling.
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + Math.floor(availableHeight));
    return visible;
  }

  private renderAll(width: number): string[] {
    const lines: string[] = [];

    // Header
    const header = " llama.cpp stats ".padEnd(width - 20) + "r refresh · q close";
    lines.push(this.theme.fg("accent", "╭─" + header + "╮"));

    // Per-backend blocks.
    for (let i = 0; i < this.stats.length; i++) {
      const stat = this.stats[i];
      if (i > 0) lines.push(""); // Blank line between backends.
      lines.push(...this.renderBackend(stat, width));
    }

    // Footer
    lines.push(this.theme.fg("muted", "╰─" + "─".repeat(width - 2) + "╯"));

    return lines;
  }

  private renderBackend(stat: BackendStats, width: number): string[] {
    const lines: string[] = [];
    const prefix = "  ";

    // Backend header line.
    const headerParts = [
      `[${stat.backend.providerId}]`,
      stat.backend.baseUrl,
    ];
    if (stat.props?.buildInfo) {
      headerParts.push(this.theme.fg("muted", `build ${stat.props.buildInfo}`));
    }
    const headerLine = `${prefix}${headerParts.join("  ")}`;
    lines.push(this.theme.fg("accent", headerLine));

    // Error line (backend unreachable).
    if (stat.error) {
      lines.push(this.theme.fg("error", `${prefix}  unreachable (${stat.error})`));
      return lines;
    }

    // Model / slots / health / ctx line.
    const infoParts: string[] = [];
    if (stat.props?.modelPath) {
      infoParts.push(`model: ${stat.props.modelPath}`);
    }
    if (stat.props?.totalSlots !== undefined) {
      infoParts.push(`slots: ${stat.props.totalSlots}`);
    }
    if (stat.props?.isSleeping !== undefined) {
      infoParts.push(`sleeping: ${stat.props.isSleeping ? "yes" : "no"}`);
    }
    if (stat.health?.status) {
      const statusColor = stat.health.status === "ok" ? "success" : "error";
      infoParts.push(`health: ${this.theme.fg(statusColor, stat.health.status)}`);
    }
    if (stat.props?.nCtx) {
      infoParts.push(`ctx: ${stat.props.nCtx}`);
    }
    if (infoParts.length > 0) {
      lines.push(`${prefix}  ${infoParts.join("   ")}`);
    }

    // Slots detail.
    if (stat.slots && stat.slots.length > 0) {
      lines.push(`${prefix}  slots:`);
      for (const slot of stat.slots) {
        lines.push(this.renderSlot(slot, width, `${prefix}    `));
      }
    }

    // Models list.
    if (stat.models && stat.models.length > 0) {
      lines.push(`${prefix}  models:`);
      for (const model of stat.models) {
        lines.push(this.renderModel(model, width, `${prefix}    `));
      }
    }

    // Metrics (prometheus).
    if (stat.metrics && this.hasMetrics(stat.metrics)) {
      lines.push(`${prefix}  metrics (prometheus):`);
      lines.push(this.renderMetrics(stat.metrics, width, `${prefix}    `));
    }

    return lines;
  }

  private renderSlot(slot: SlotStats, width: number, prefix: string): string {
    const parts = [
      `#${slot.id}`,
      slot.isProcessing
        ? this.theme.fg("warning", "busy")
        : this.theme.fg("muted", "idle"),
      slot.nCtx ? `ctx ${slot.nCtx}` : "",
      slot.nDecoded !== undefined ? `decoded ${slot.nDecoded}` : "",
      slot.nRemain !== undefined ? `remain ${slot.nRemain}` : "",
    ].filter(Boolean);

    if (slot.predictedPerSecond) {
      parts.push(`${slot.predictedPerSecond.toFixed(1)} tok/s`);
    }

    return truncateToWidth(`${prefix}${parts.join("  ")}`, width);
  }

  private renderModel(model: ModelStats, width: number, prefix: string): string {
    const parts = [
      model.id,
      model.status ? this.theme.fg(model.status === "loaded" ? "success" : "muted", model.status) : "",
      model.nParams ? `${this.formatParams(model.nParams)} params` : "",
      model.size ? `${this.formatBytes(model.size)}` : "",
    ].filter(Boolean);

    return truncateToWidth(`${prefix}${parts.join("  ")}`, width);
  }

  private renderMetrics(metrics: MetricsStats, width: number, prefix: string): string {
    const parts: string[] = [];
    if (metrics.promptTokensPerSecond !== undefined) {
      parts.push(`prompt ${metrics.promptTokensPerSecond.toFixed(1)} tok/s`);
    }
    if (metrics.predictedTokensPerSecond !== undefined) {
      parts.push(`predicted ${metrics.predictedTokensPerSecond.toFixed(1)} tok/s`);
    }
    const processing = metrics.requestsProcessing ?? 0;
    const deferred = metrics.requestsDeferred ?? 0;
    parts.push(`req ${processing}/${deferred}`);
    if (metrics.tokensPredictedTotal !== undefined) {
      parts.push(`total ${this.formatNumber(metrics.tokensPredictedTotal)} tok`);
    }

    return truncateToWidth(`${prefix}${parts.join("  ")}`, width);
  }

  // -----------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------

  handleInput(data: string): void {
    // Close on q or escape.
    if (data === "q" || data === "\x1b" || data === "escape") {
      this.dispose();
      this._onDone();
      return;
    }

    // Force refresh on r.
    if (data === "r") {
      this.scheduleRefresh();
      return;
    }

    // Scroll up/down.
    if (data === "up" || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (data === "down" || data === "j") {
      this.scrollOffset = Math.min(this.scrollMax, this.scrollOffset + 1);
      this.tui.requestRender();
      return;
    }
  }

  // -----------------------------------------------------------------
  // Refresh loop
  // -----------------------------------------------------------------

  /** Schedule a refresh using recursive setTimeout (avoids request stacking). */
  private scheduleRefresh(): void {
    // Guard: don't start a new fetch if one is already in flight.
    if (this.isFetching) return;

    this.isFetching = true;
    this.fetchAll().finally(() => {
      this.isFetching = false;
      // Schedule the next refresh only after the current one completes.
      this.refreshTimer = setTimeout(() => this.scheduleRefresh(), REFRESH_INTERVAL_MS);
    });
  }

  /** Fetch stats for all backends and update the view. */
  private async fetchAll(): Promise<void> {
    // Check if the view was aborted during the async gap.
    if (!this.abortController || this.abortController.signal.aborted) return;

    const results = await Promise.all(
      this.backends.map((b) => fetchBackendStats(b, this.abortController!.signal)),
    );

    // Check again after fetch completes.
    if (this.abortController?.signal.aborted) return;

    this.stats = results;
    this.tui.requestRender();
  }

  // -----------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------

  /** Dispose all resources: abort fetches, clear timers. */
  dispose(): void {
    // Abort any in-flight fetches immediately.
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clear the pending refresh timer.
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.isFetching = false;
  }

  invalidate(): void {
    this.width = null;
  }

  // -----------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------

  private formatParams(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  private formatBytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
    return `${n} B`;
  }

  private formatNumber(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }

  private hasMetrics(m: MetricsStats): boolean {
    return Object.values(m).some((v) => v !== undefined);
  }
}
