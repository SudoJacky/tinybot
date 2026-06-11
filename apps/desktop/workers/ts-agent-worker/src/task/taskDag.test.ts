import { describe, expect, test } from "vitest";

import {
  canExecuteSubtask,
  isPlanBlocked,
  isPlanCompleted,
  normalizeTaskPlan,
  readySubtasks,
  validateTaskDag,
} from "./taskDag";
import type { TaskPlanInput } from "./taskTypes";

function plan(overrides: Partial<TaskPlanInput> = {}): TaskPlanInput {
  return {
    id: "plan-1",
    title: "Migrate backend",
    original_request: "Move backend runtime to TS",
    status: "planning",
    subtasks: [
      {
        id: "a",
        title: "Foundation",
        description: "Build the foundation",
        status: "completed",
      },
      {
        id: "b",
        title: "Runtime",
        description: "Build the runtime",
        dependencies: ["a"],
        status: "pending",
      },
      {
        id: "c",
        title: "Blocked",
        description: "Wait for runtime",
        dependencies: ["b"],
        status: "pending",
        parallel_safe: false,
      },
    ],
    ...overrides,
  };
}

describe("taskDag", () => {
  test("normalizes Python-style task plans while preserving task defaults", () => {
    const normalized = normalizeTaskPlan(plan());

    expect(normalized.originalRequest).toBe("Move backend runtime to TS");
    expect(normalized.subtasks[0]).toMatchObject({
      id: "a",
      status: "completed",
      dependencies: [],
      parallelSafe: true,
      retryCount: 0,
      maxRetries: 2,
    });
    expect(normalized.subtasks[2]).toMatchObject({
      id: "c",
      dependencies: ["b"],
      parallelSafe: false,
    });
  });

  test("validates missing dependencies and dependency cycles like Python TaskManager", () => {
    const missing = validateTaskDag(
      normalizeTaskPlan({
        ...plan(),
        subtasks: [
          { id: "a", title: "A", description: "A", dependencies: ["missing"] },
          { id: "b", title: "B", description: "B", dependencies: ["a"] },
        ],
      }),
    );
    expect(missing).toEqual(["Subtask 'a' depends on non-existent 'missing'"]);

    const cycle = validateTaskDag(
      normalizeTaskPlan({
        ...plan(),
        subtasks: [
          { id: "a", title: "A", description: "A", dependencies: ["c"] },
          { id: "b", title: "B", description: "B", dependencies: ["a"] },
          { id: "c", title: "C", description: "C", dependencies: ["b"] },
        ],
      }),
    );
    expect(cycle).toContain("Cycle detected: a -> b -> c -> a");
  });

  test("finds ready subtasks only when dependencies are completed", () => {
    const normalized = normalizeTaskPlan(plan());

    expect(canExecuteSubtask(normalized.subtasks[0], normalized)).toBe(false);
    expect(canExecuteSubtask(normalized.subtasks[1], normalized)).toBe(true);
    expect(canExecuteSubtask(normalized.subtasks[2], normalized)).toBe(false);
    expect(readySubtasks(normalized).map((subtask) => subtask.id)).toEqual(["b"]);
  });

  test("reports completed and blocked plan states", () => {
    expect(
      isPlanCompleted(
        normalizeTaskPlan({
          ...plan(),
          subtasks: [
            { id: "a", title: "A", description: "A", status: "completed" },
            { id: "b", title: "B", description: "B", status: "skipped" },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      isPlanBlocked(
        normalizeTaskPlan({
          ...plan(),
          subtasks: [
            { id: "a", title: "A", description: "A", status: "failed" },
            { id: "b", title: "B", description: "B", dependencies: ["a"], status: "pending" },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      isPlanBlocked(
        normalizeTaskPlan({
          ...plan(),
          subtasks: [
            { id: "a", title: "A", description: "A", status: "in_progress" },
            { id: "b", title: "B", description: "B", dependencies: ["a"], status: "pending" },
          ],
        }),
      ),
    ).toBe(false);
  });
});
