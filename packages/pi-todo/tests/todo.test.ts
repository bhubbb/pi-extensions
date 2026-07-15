import { describe, it, expect, beforeEach } from "bun:test";
import { applyTaskMutation } from "../src/state/state-reducer.js";
import { EMPTY_STATE, type TaskState } from "../src/state/state.js";
import { __resetState, getState, commitState } from "../src/state/store.js";
import { selectVisibleTasks, selectTodoCounts, selectTasksByStatus, selectActiveGoals, selectGoalsByStatus, selectTasksByGoal } from "../src/state/selectors.js";
import type { Goal, Task } from "../src/tool/types.js";

describe("pi-todo: Goal and Todo management", () => {
  let state: TaskState;

  beforeEach(() => {
    __resetState();
    state = { ...EMPTY_STATE };
  });

  // -----------------------------------------------------------------------
  // Goal CRUD
  // -----------------------------------------------------------------------

  describe("goals", () => {
    it("add_goal creates a new goal with active status", () => {
      const result = applyTaskMutation(state, "add_goal", { title: "Implement auth" });
      expect(result.op.kind).toBe("create_goal");
      expect(result.state.goals.length).toBe(1);
      expect(result.state.goals[0].status).toBe("active");
      expect(result.state.goals[0].title).toBe("Implement auth");
    });

    it("add_goal requires a title", () => {
      const result = applyTaskMutation(state, "add_goal", { title: "" });
      expect(result.op.kind).toBe("error");
    });

    it("add_goal with description and file stores them", () => {
      const result = applyTaskMutation(state, "add_goal", {
        title: "Implement auth",
        description: "Add OAuth2 login",
        file: "src/auth.ts",
      });
      expect(result.state.goals[0].description).toBe("Add OAuth2 login");
      expect(result.state.goals[0].file).toBe("src/auth.ts");
    });

    it("complete_goal cascades done to all tasks in that goal", () => {
      // Create goal + tasks
      let s = applyTaskMutation(state, "add_goal", { title: "Test goal" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId });

      // Complete goal
      const result = applyTaskMutation(s.state, "complete_goal", { goalId });
      expect(result.op.kind).toBe("complete_goal");
      expect(result.state.goals[0].status).toBe("completed");
      // All tasks should be completed
      for (const task of result.state.tasks) {
        expect(task.status).toBe("completed");
      }
    });

    it("abandon_goal leaves tasks untouched", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Abandoned goal" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "abandon_goal", { goalId });
      expect(result.op.kind).toBe("abandon_goal");
      expect(result.state.goals[0].status).toBe("abandoned");
      // Task should still be in_progress
      expect(result.state.tasks[0].status).toBe("in_progress");
    });

    it("delete_goal removes goal AND all its tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "To delete" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId });

      const result = applyTaskMutation(s.state, "delete_goal", { goalId });
      expect(result.op.kind).toBe("delete_goal");
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });

    it("clear_goal removes all goals and tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });
      s = applyTaskMutation(s.state, "create", { subject: "Task", goalId: 1 });

      const result = applyTaskMutation(s.state, "clear_goal", {});
      expect(result.op.kind).toBe("clear_goal");
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });

    it("list_goal returns all goals", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });

      const result = applyTaskMutation(s.state, "list_goal", {});
      expect(result.op.kind).toBe("list_goal");
      expect(result.state.goals.length).toBe(2);
    });

    it("get_goal returns a single goal", () => {
      const s = applyTaskMutation(state, "add_goal", { title: "My goal" });
      const result = applyTaskMutation(s.state, "get_goal", { goalId: 1 });
      expect(result.op.kind).toBe("get_goal");
      expect(result.op.goal.title).toBe("My goal");
    });

    it("soft cap of 20 goals — reuses abandoned goals at cap", () => {
      let s = state;
      // Create 20 goals
      for (let i = 0; i < 20; i++) {
        s = applyTaskMutation(s, "add_goal", { title: `Goal ${i}` }).state;
      }
      // 21st should fail
      let result = applyTaskMutation(s, "add_goal", { title: "Goal 21" });
      expect(result.op.kind).toBe("error");

      // Abandon one goal
      s = applyTaskMutation(s, "abandon_goal", { goalId: 1 }).state;
      // Now 21st should work (reuses abandoned)
      result = applyTaskMutation(s, "add_goal", { title: "Goal 21" });
      expect(result.op.kind).toBe("create_goal");
    });
  });

  // -----------------------------------------------------------------------
  // Task CRUD with goalId
  // -----------------------------------------------------------------------

  describe("tasks", () => {
    it("create requires goalId", () => {
      const result = applyTaskMutation(state, "create", { subject: "Task" });
      expect(result.op.kind).toBe("error");
      expect(result.op.message).toContain("goalId");
    });

    it("create with valid goalId adds task to goal", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      const result = applyTaskMutation(s.state, "create", { subject: "Do thing", goalId: 1 });
      expect(result.op.kind).toBe("create");
      expect(result.state.tasks[0].goalId).toBe(1);
      expect(result.state.tasks[0].subject).toBe("Do thing");
    });

    it("create with invalid goalId errors", () => {
      const result = applyTaskMutation(state, "create", { subject: "Task", goalId: 999 });
      expect(result.op.kind).toBe("error");
    });

    it("soft cap of 50 tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      let current = s.state;
      for (let i = 0; i < 50; i++) {
        current = applyTaskMutation(current, "create", { subject: `Task ${i}`, goalId: 1 }).state;
      }
      const result = applyTaskMutation(current, "create", { subject: "Task 51", goalId: 1 });
      expect(result.op.kind).toBe("error");
      expect(result.op.message).toContain("max tasks");
    });

    it("blockedBy validates deps exist", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      const result = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1, blockedBy: [999] });
      expect(result.op.kind).toBe("error");
    });

    it("blockedBy validates deps not deleted", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "delete", { id: 1 });
      const result = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1, blockedBy: [1] });
      expect(result.op.kind).toBe("error");
    });
  });

  // -----------------------------------------------------------------------
  // Selectors
  // -----------------------------------------------------------------------

  describe("selectors", () => {
    it("selectVisibleTasks excludes deleted", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "delete", { id: 1 });

      const visible = selectVisibleTasks(s.state);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe(2);
    });

    it("selectTasksByStatus groups correctly", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "P", goalId: 1 }); // pending
      s = applyTaskMutation(s.state, "create", { subject: "I", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "in_progress" });
      s = applyTaskMutation(s.state, "create", { subject: "C", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 3, status: "completed" });

      const groups = selectTasksByStatus(s.state);
      expect(groups.pending.length).toBe(1);
      expect(groups.inProgress.length).toBe(1);
      expect(groups.completed.length).toBe(1);
    });

    it("selectActiveGoals returns only active goals", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Active" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Done" });
      s = applyTaskMutation(s.state, "complete_goal", { goalId: 2 });

      const active = selectActiveGoals(s.state);
      expect(active.length).toBe(1);
      expect(active[0].title).toBe("Active");
    });

    it("selectGoalsByStatus groups by status", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Active" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Done" });
      s = applyTaskMutation(s.state, "complete_goal", { goalId: 2 });
      s = applyTaskMutation(s.state, "add_goal", { title: "Abandoned" });
      s = applyTaskMutation(s.state, "abandon_goal", { goalId: 3 });

      const groups = selectGoalsByStatus(s.state);
      expect(groups.active.length).toBe(1);
      expect(groups.completed.length).toBe(1);
      expect(groups.abandoned.length).toBe(1);
    });

    it("selectTasksByGoal returns tasks for a specific goal", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId: 2 });

      const goal1Tasks = selectTasksByGoal(s.state, 1);
      expect(goal1Tasks.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Referential integrity
  // -----------------------------------------------------------------------

  describe("referential integrity", () => {
    it("add_todo without valid goalId → error, no mutation", () => {
      const result = applyTaskMutation(state, "create", { subject: "Orphan" });
      expect(result.op.kind).toBe("error");
      expect(result.state.tasks.length).toBe(0);
    });

    it("add_todo with bogus goalId → error, no mutation", () => {
      const result = applyTaskMutation(state, "create", { subject: "Orphan", goalId: 999 });
      expect(result.op.kind).toBe("error");
      expect(result.state.tasks.length).toBe(0);
    });

    it("complete_goal cascades todo.done = true", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "complete_goal", { goalId: 1 });
      expect(result.state.tasks[0].status).toBe("completed");
    });

    it("abandon_goal leaves todos untouched", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "abandon_goal", { goalId: 1 });
      expect(result.state.tasks[0].status).toBe("in_progress");
      expect(result.state.goals[0].status).toBe("abandoned");
    });

    it("clear_goal removes goal + its todos", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });

      const result = applyTaskMutation(s.state, "delete_goal", { goalId: 1 });
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });
  });
});