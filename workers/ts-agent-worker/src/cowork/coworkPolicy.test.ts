import { describe, expect, test } from "vitest";

import {
  architectureFallbackDiagnostic,
  architectureLabel,
  normalizeArchitectureName,
} from "./coworkArchitecture";
import { defaultPolicyRegistry } from "./coworkPolicy";
import { normalizeCoworkSession } from "./coworkSerde";
import { coworkSessionSnapshot } from "./coworkSnapshot";

const session = normalizeCoworkSession({
  id: "cw-policy-1",
  title: "Team delivery",
  goal: "Coordinate a team of specialists and synthesize the answer",
  status: "active",
  workflow_mode: "team",
  current_branch_id: "default",
  agents: {
    coordinator: {
      id: "coordinator",
      name: "Coordinator",
      role: "Coordinator",
      goal: "Coordinate",
      status: "working",
      responsibilities: ["Plan work"],
    },
    researcher: {
      id: "researcher",
      name: "Researcher",
      role: "Research",
      goal: "Find facts",
      status: "idle",
      responsibilities: ["Research facts"],
      team_id: "research",
    },
  },
  tasks: {
    task_1: {
      id: "task_1",
      title: "Research",
      description: "Find facts",
      assigned_agent_id: "researcher",
      status: "pending",
    },
  },
});

describe("cowork architecture", () => {
  test("normalizes legacy aliases and labels canonical architecture names", () => {
    expect(normalizeArchitectureName("hybrid")).toBe("adaptive_starter");
    expect(normalizeArchitectureName("generator-verifier")).toBe("generator_verifier");
    expect(normalizeArchitectureName("mystery")).toBe("adaptive_starter");
    expect(architectureLabel("team")).toBe("Agent Team");
    expect(architectureLabel("mystery")).toBe("Adaptive Starter");
    expect(architectureFallbackDiagnostic("mystery", { path: "architecture" })).toEqual({
      severity: "warning",
      code: "unknown_architecture_fallback",
      message: "Unknown Cowork architecture 'mystery' was normalized to 'adaptive_starter'.",
      path: "architecture",
      value: "mystery",
    });
    expect(architectureFallbackDiagnostic("hybrid")).toBeNull();
  });
});

describe("cowork architecture policy registry", () => {
  test("resolves supported default policies and falls back through adaptive starter", () => {
    const registry = defaultPolicyRegistry();

    expect(registry.architectures).toEqual([
      "adaptive_starter",
      "generator_verifier",
      "message_bus",
      "shared_state",
      "swarm",
      "team",
    ]);
    expect(registry.resolve("hybrid").architecture).toBe("adaptive_starter");
    expect(registry.resolve("supervisor").architecture).toBe("adaptive_starter");
    expect(registry.resolve("unknown").architecture).toBe("adaptive_starter");
    expect(registry.resolve("team")).toMatchObject({
      architecture: "team",
      displayName: "Agent Team",
      runtimeProfile: "team",
    });
  });

  test("projects topology and organization sections through policy capabilities", () => {
    const policy = defaultPolicyRegistry().resolve("team");

    const topology = policy.topology(session, { branchId: "default" });
    const projection = policy.buildProjection(session, { branchId: "default" });

    expect(topology).toMatchObject({
      status: "available",
      payload: {
        schema_version: "cowork.architecture_topology.v1",
        architecture: "team",
        branch_id: "default",
        metadata: {
          policy: "AgentTeamPolicy",
          display_name: "Agent Team",
          runtime_profile: "team",
          coordinator_id: "coordinator",
          worker_count: 1,
        },
      },
    });
    expect(topology.payload.roles).toEqual([
      expect.objectContaining({ id: "coordinator", status: "working" }),
      expect.objectContaining({ id: "researcher", status: "idle" }),
    ]);
    expect(topology.payload.relationships).toEqual(expect.arrayContaining([
      { from: "session", to: "coordinator", kind: "member" },
      { from: "session", to: "researcher", kind: "member" },
      {
        from: "coordinator",
        to: "researcher",
        kind: "coordinates_worker_domain",
        worker_domain: "research",
      },
    ]));
    expect(projection.payload.sections.map((section) => section.id)).toEqual([
      "coordinator",
      "worker_domains",
      "team_synthesis",
    ]);
    expect(projection.payload.metadata.completion).toMatchObject({
      next_action: "run_next_round",
      ready_to_finish: false,
      coordinator_id: "coordinator",
    });
  });

  test("cowork snapshots consume the policy registry for architecture projection", () => {
    const snapshot = coworkSessionSnapshot(session);

    expect(snapshot.architecture_topology).toMatchObject({
      schema_version: "cowork.architecture_topology.v1",
      architecture: "team",
      metadata: {
        policy: "AgentTeamPolicy",
        worker_count: 1,
      },
    });
    expect(snapshot.organization_projection).toMatchObject({
      schema_version: "cowork.organization_projection.v1",
      architecture: "team",
      display_name: "Agent Team",
    });
    expect((snapshot.organization_projection as { sections: Array<{ id: string }> }).sections.map((section) => section.id)).toEqual([
      "coordinator",
      "worker_domains",
      "team_synthesis",
    ]);
  });
});
