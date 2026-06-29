import { describe, expect, test } from "vitest";

import { normalizeTaskPlan } from "./taskDag";
import { taskProgressPayload } from "./taskProgress";

describe("taskProgressPayload", () => {
  test("matches the legacy TaskManager progress summary shape", () => {
    const plan = normalizeTaskPlan({
      id: "plan-1",
      title: "Backend migration",
      original_request: "Move backend runtime to TS",
      status: "executing",
      subtasks: [
        { id: "a", title: "Foundation", description: "Done", status: "completed" },
        { id: "b", title: "Runtime", description: "Running", status: "in_progress" },
        { id: "c", title: "Bridge", description: "Next", dependencies: ["a"], status: "pending" },
        { id: "d", title: "Retry", description: "Failed", status: "failed" },
        { id: "e", title: "Skipped", description: "Skipped", status: "skipped" },
      ],
    });

    expect(taskProgressPayload(plan)).toEqual({
      plan_id: "plan-1",
      title: "Backend migration",
      status: "executing",
      total: 5,
      completed: 1,
      in_progress: 1,
      pending: 1,
      failed: 1,
      skipped: 1,
      current: "Runtime",
      current_all: ["Runtime"],
      next: "Bridge",
    });
  });
});
