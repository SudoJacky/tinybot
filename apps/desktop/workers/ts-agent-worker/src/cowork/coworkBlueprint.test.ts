import { describe, expect, test } from "vitest";

import { previewBlueprint, validateBlueprint } from "./coworkBlueprint";

describe("cowork blueprint runtime", () => {
  test("previews a minimal blueprint without requiring persisted session state", () => {
    const preview = previewBlueprint({ goal: "Plan launch", workflow_mode: "hybrid" });

    expect(preview.ok).toBe(true);
    expect(preview.blueprint).toMatchObject({
      schema_version: "cowork.blueprint.v1",
      goal: "Plan launch",
      title: "Plan launch",
      workflow_mode: "adaptive_starter",
      lead_agent_id: "coordinator",
    });
    expect(preview.blueprint.id).toMatch(/^bp_[a-f0-9]{12}$/);
    expect(preview.blueprint.agents.map((agent) => agent.id)).toEqual(["coordinator", "researcher", "analyst"]);
    expect(preview.blueprint.tasks).toEqual([
      expect.objectContaining({
        id: "lead_start",
        assigned_agent_id: "coordinator",
      }),
    ]);
    expect(preview.graph_preview).toMatchObject({
      schema_version: "cowork.graph.preview.v1",
      stats: {
        node_kinds: { agent: 3, session: 1, task: 1 },
      },
      truncated: { nodes: false, edges: false, hidden_nodes: 0, hidden_edges: 0 },
    });
    expect(preview.initial_ready_work).toEqual({
      ready_task_ids: ["lead_start"],
      ready_by_agent: { coordinator: ["lead_start"] },
      lead_agent_id: "coordinator",
    });
  });

  test("reports legacy-compatible blueprint diagnostics", () => {
    const result = validateBlueprint({
      goal: "Validate",
      architecture: "mystery",
      agents: [
        { id: "lead", name: "Lead", role: "Lead", goal: "Lead", tools: ["cowork_internal"] },
        { id: "lead", name: "Dupe", role: "Dupe", goal: "Dupe", tools: ["shell"] },
      ],
      tasks: [
        { id: "a", title: "A", description: "A", dependencies: ["b"], assigned_agent_id: "missing" },
        { id: "b", title: "B", description: "B", dependencies: ["a"] },
      ],
      routes: [{ from: "lead", to: "missing" }],
      budgets: { parallel_width: 100, max_agent_calls: 12 },
    }, { allowed_tools: ["cowork_internal"] });

    expect(result.ok).toBe(false);
    expect(result.blueprint.workflow_mode).toBe("adaptive_starter");
    expect(result.blueprint.budgets.parallel_width).toBe(50);
    expect(new Set(result.diagnostics.map((item) => item.code))).toEqual(new Set([
      "duplicate_id",
      "unknown_architecture_fallback",
      "tool_disallowed",
      "missing_task_owner",
      "missing_route_target",
      "task_dependency_cycle",
      "budget_clamped",
    ]));
  });
});
