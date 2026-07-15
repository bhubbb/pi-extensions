/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 * Extended with goal grouping.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatGoalStatusLabel, formatStatusLabel } from "./state/i18n-bridge.js";
import { selectGoalTitleById, selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getState } from "./state/store.js";
import { formatOverlayGoalLine, formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "pi-todos";
const MAX_WIDGET_LINES = 12;

const OVERLAY_HEADING = "Todos";
const OVERLAY_GOALS_HEADING = "Goals";
const OVERLAY_MORE = "more";

export class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private completedTaskIdsPendingHide = new Set<number>();
  private hiddenCompletedTaskIds = new Set<number>();
  private lastNextId: number | undefined;

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = this.selectOverlayTasks(snapshot);

    if (visible.tasks.length === 0 && visible.goals.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(theme, width),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  resetCompletedDisplayState(): void {
    this.completedTaskIdsPendingHide.clear();
    this.hiddenCompletedTaskIds.clear();
    this.lastNextId = undefined;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    if (this.completedTaskIdsPendingHide.size === 0) return;
    for (const taskId of this.completedTaskIdsPendingHide) {
      this.hiddenCompletedTaskIds.add(taskId);
    }
    this.completedTaskIdsPendingHide.clear();
    this.tui?.requestRender();
  }

  private getSnapshot() {
    const state = getState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.resetCompletedDisplayState();
    }
    this.lastNextId = state.nextId;
    return { tasks: [...state.tasks], goals: [...state.goals], nextId: state.nextId };
  }

  private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
    return {
      tasks: snapshot.tasks.filter((t) => t.status !== "deleted" && !this.shouldHideCompletedTask(t)),
      goals: snapshot.goals.filter((g) => g.status === "active"),
    };
  }

  private shouldHideCompletedTask(task: { status: string; id: number }): boolean {
    return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.getSnapshot();
    const overlayData = this.selectOverlayTasks(snapshot);
    if (overlayData.tasks.length === 0 && overlayData.goals.length === 0) return [];

    const overlayState = { goals: overlayData.goals, tasks: overlayData.tasks, nextGoalId: 1, nextId: snapshot.nextId };
    const truncate = (line: string): string => truncateToWidth(line, width, "…");
    const counts = selectTodoCounts(overlayState);
    const hasActive = selectHasActive(overlayState);
    const showIds = selectShowTaskIds(overlayState);

    const lines: string[] = [];

    // Goals heading
    if (overlayData.goals.length > 0) {
      const goalsCount = overlayData.goals.length;
      const goalsText = `${theme.fg("muted", `${OVERLAY_GOALS_HEADING} (${goalsCount})`)}`;
      lines.push(truncate(goalsText));
      for (const goal of overlayData.goals) {
        lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayGoalLine(goal, theme)}`));
      }
    }

    // Tasks heading
    if (overlayData.tasks.length > 0) {
      if (overlayData.goals.length > 0) lines.push(truncate("")); // spacer between goals and tasks
      const headingColor = hasActive ? "accent" : "dim";
      const headingIcon = hasActive ? "●" : "○";
      const headingText = `${OVERLAY_HEADING} (${counts.completed}/${counts.total})`;
      lines.push(truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`));

      const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - lines.length - 2);
      for (const task of layout.visible) {
        const goalTitle = selectGoalTitleById(overlayState, task.goalId);
        lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds, goalTitle)}`));
      }

      // Track newly completed tasks for auto-hide
      const newlyDisplayedCompletedTaskIds = overlayData.tasks
        .filter(
          (task) =>
            task.status === "completed" &&
            !this.completedTaskIdsPendingHide.has(task.id) &&
            !this.hiddenCompletedTaskIds.has(task.id),
        )
        .map((task) => task.id);
      for (const taskId of newlyDisplayedCompletedTaskIds) {
        this.completedTaskIdsPendingHide.add(taskId);
      }

      if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0 && lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
      } else if (layout.hiddenCompleted > 0 || layout.truncatedTail > 0) {
        const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
        const overflowParts: string[] = [];
        if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
        if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
        const more = OVERLAY_MORE;
        const summary = overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
        lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
      }
    }

    return this.withTrailingSpacer(lines);
  }

  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    lines.push("");
    return lines;
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.resetCompletedDisplayState();
  }
}