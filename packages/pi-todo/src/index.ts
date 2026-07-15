/**
 * pi-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * Extends the rpiv-todo pattern with goals for task grouping.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replayFromBranch } from "./state/replay.js";
import { replaceState } from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
  let todoOverlay: TodoOverlay | undefined;

  registerTodoTool(pi);
  registerTodosCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    replaceState(replayFromBranch(ctx));
    if (ctx.hasUI) {
      todoOverlay ??= new TodoOverlay();
      todoOverlay.setUICtx(ctx.ui);
      todoOverlay.resetCompletedDisplayState();
      todoOverlay.update();
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    try {
      replaceState(replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    try {
      replaceState(replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_shutdown", async () => {
    todoOverlay?.dispose();
    todoOverlay = undefined;
  });

  // Reads getTodos() at render time; do NOT call replayFromBranch here.
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    todoOverlay?.update();
  });

  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}