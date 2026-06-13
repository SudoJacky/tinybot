import { describe, expect, test } from "vitest";

import { buildDesktopCoworkCockpitView, buildDesktopCoworkSessionRows } from "../../../../src/desktopCowork";
import { normalizeCoworkSession } from "./coworkSerde";
import { coworkSessionSnapshot } from "./coworkSnapshot";

const isoTimestamp = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

const rawSession = {
  id: "cw-snap-1",
  title: "Launch plan",
  goal: "Plan the product launch",
  status: "active",
  workflow_mode: "hybrid",
  current_branch_id: "default",
  created_at: "2026-06-12T10:00:00",
  updated_at: "2026-06-12T10:05:00",
  agents: {
    lead: {
      id: "lead",
      name: "Lead",
      role: "Coordinator",
      goal: "Coordinate launch",
      status: "working",
      private_summary: "private agent memory",
      current_task_id: "task_1",
      tools: ["cowork_internal"],
    },
  },
  tasks: {
    task_1: {
      id: "task_1",
      title: "Research launch",
      description: "Gather launch facts",
      assigned_agent_id: "lead",
      status: "completed",
      result: "Launch facts gathered",
      result_data: { answer: "Use staged rollout", artifacts: ["docs/launch.md"] },
      confidence: 0.8,
      updated_at: "2026-06-12T10:04:00",
    },
  },
  threads: {
    thread_1: {
      id: "thread_1",
      topic: "Launch",
      participant_ids: ["lead"],
      message_ids: ["msg_1"],
      status: "open",
      updated_at: "2026-06-12T10:03:00",
    },
  },
  messages: {
    msg_1: {
      id: "msg_1",
      thread_id: "thread_1",
      sender_id: "lead",
      recipient_ids: ["user"],
      content: "public update",
      created_at: "2026-06-12T10:03:00",
    },
  },
  mailbox: {
    env_1: {
      id: "env_1",
      sender_id: "user",
      recipient_ids: ["lead"],
      content: "secret user request",
      kind: "question",
      request_type: "clarify",
      status: "delivered",
      requires_reply: true,
      priority: 5,
      blocking_task_id: "task_1",
      created_at: "2026-06-12T10:02:00",
      updated_at: "2026-06-12T10:02:00",
    },
  },
  events: [
    {
      id: "event_1",
      type: "task.completed",
      message: "Task completed",
      actor_id: "lead",
      data: { task_id: "task_1", status: "completed" },
      created_at: "2026-06-12T10:04:00",
    },
  ],
  trace_spans: [
    {
      id: "span_1",
      session_id: "cw-snap-1",
      kind: "agent",
      name: "Lead round",
      actor_id: "lead",
      status: "completed",
      summary: "Agent finished",
      input_ref: "private input",
      output_ref: "private output",
      data: { prompt: "hidden prompt" },
      started_at: "2026-06-12T10:03:00",
    },
  ],
  artifacts: ["reports/launch-plan.md"],
  shared_memory: { findings: [{ text: "Launch requires staged rollout", source_task_id: "task_1" }] },
  final_draft: "Final launch draft",
  completion_decision: { next_action: "complete", ready_to_finish: true, reason: "Enough evidence" },
  budget_usage: { rounds: 1, agent_calls: 2, tokens_total: 42 },
};

describe("cowork session snapshot", () => {
  test("builds a verbose desktop-compatible read-only snapshot", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession(rawSession));

    expect(snapshot).toMatchObject({
      id: "cw-snap-1",
      title: "Launch plan",
      workflow_mode: "adaptive_starter",
      architecture: "adaptive_starter",
      current_branch_id: "default",
      budget: {
        usage: expect.objectContaining({ rounds: 1, agent_calls: 2, tokens_total: 42 }),
      },
      blueprint_metadata: {},
    });
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: "lead",
        private_summary: "private agent memory",
        inbox_count: 0,
        current_task_title: "Research launch",
      }),
    ]);
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({
        id: "task_1",
        description: "Gather launch facts",
        result: "Launch facts gathered",
        result_data: { answer: "Use staged rollout", artifacts: ["docs/launch.md"] },
      }),
    ]);
    expect(snapshot.graph).toMatchObject({
      schema_version: "cowork.graph.v2",
      stats: expect.objectContaining({ tasks: 1, total_agents: 1 }),
    });
    expect(snapshot.graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["session", "agent:lead", "task:task_1"]));
    expect(snapshot.trace).toEqual([
      expect.objectContaining({
        id: "event_1",
        stage: "task",
        action: "Task completed",
        detail: "Task completed",
        payload: { task_id: "task_1", status: "completed" },
      }),
    ]);
    expect(snapshot.task_dag).toMatchObject({
      stats: expect.objectContaining({ tasks: 1, artifacts: 1 }),
    });
    expect(snapshot.artifact_index).toEqual([
      expect.objectContaining({ path_or_url: "docs/launch.md", source_task_id: "task_1" }),
      expect.objectContaining({ path_or_url: "reports/launch-plan.md" }),
    ]);

    const cockpit = buildDesktopCoworkCockpitView(snapshot);
    expect(cockpit.header.title).toBe("Launch plan");
    expect(cockpit.agents).toHaveLength(1);
    expect(cockpit.tasks[0]?.resultText).toBe("Use staged rollout");
    expect(cockpit.graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["session", "agent:lead", "task:task_1"]));
    expect(cockpit.artifacts.map((artifact) => artifact.location)).toEqual(["docs/launch.md", "reports/launch-plan.md"]);
  });

  test("builds a non-verbose list snapshot without private content", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession(rawSession), { verbose: false });

    expect(snapshot.agents[0]?.private_summary).toBe("");
    expect(snapshot.tasks[0]).toMatchObject({ description: "", result: "", result_data: {} });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.mailbox).toEqual([]);
    expect(snapshot.trace_spans).toEqual([]);
    expect(snapshot.agent_steps).toEqual([]);
    expect(snapshot.observation_details).toEqual({});
    expect(snapshot.blueprint).toEqual({});
    expect(snapshot.graph).toBeUndefined();
    expect(snapshot.trace).toBeUndefined();
    expect(snapshot.task_dag).toBeUndefined();
    expect(snapshot.artifact_index).toBeUndefined();

    const rows = buildDesktopCoworkSessionRows({ items: [snapshot] });
    expect(rows).toEqual([
      expect.objectContaining({
        id: "cw-snap-1",
        title: "Launch plan",
        workflow: "Adaptive Starter",
        agentCount: 1,
        finalOutput: "Final launch draft",
      }),
    ]);
  });

  test("projects large swarm fixtures for clustered desktop rendering", () => {
    const workUnits = Array.from({ length: 120 }, (_, index) => {
      const value = index + 1;
      return {
        id: `wu_${String(value).padStart(3, "0")}`,
        title: `Large unit ${String(value).padStart(3, "0")}`,
        status: value <= 60 ? "completed" : "pending",
        kind: "fanout",
        assigned_agent_id: `worker_${((value - 1) % 8) + 1}`,
        fanout_group_id: `stream_${Math.floor((value - 1) / 15) + 1}`,
        source_task_id: `unit_${String(value).padStart(3, "0")}`,
      };
    });
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession({
      ...rawSession,
      id: "cw-large-swarm",
      title: "Large swarm fixture",
      goal: "Validate a large swarm with more than one hundred work units",
      workflow_mode: "swarm",
      swarm_plan: {
        id: "swarm_1",
        status: "active",
        work_units: workUnits,
        reducer: { required: true, agent_id: "lead" },
        review: { required: false },
      },
    }));

    expect(snapshot.swarm_organization).toMatchObject({
      schema_version: "cowork.swarm_organization.v1",
      generated_at: isoTimestamp,
      plan_id: "swarm_1",
      enabled: true,
      total_work_units: 120,
      grouped_counts: {
        workstreams: 8,
        work_units: 120,
      },
    });
    expect(snapshot.swarm_organization.workstreams).toHaveLength(8);
    expect(snapshot.swarm_organization.workstreams[0]).toMatchObject({
      id: "stream_1",
      title: "Stream 1",
      unit_counts: { completed: 15 },
      sample_unit_ids: ["wu_001", "wu_002", "wu_003", "wu_004", "wu_005", "wu_006", "wu_007", "wu_008"],
    });
    expect(snapshot.large_swarm_summary).toMatchObject({
      schema_version: "cowork.large_swarm.v1",
      generated_at: isoTimestamp,
      enabled: true,
      total_work_units: 120,
      render_limit: 60,
      status_counts: { completed: 60, pending: 60 },
    });
    expect(snapshot.large_swarm_summary.workstreams).toHaveLength(8);
  });

  test("projects Python-compatible swarm scheduler queues and metrics", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession({
      ...rawSession,
      id: "cw-swarm-queues",
      workflow_mode: "swarm",
      budget_limits: { parallel_width: 2 },
      tasks: {
        completed: {
          ...rawSession.tasks.task_1,
          id: "completed",
          status: "completed",
        },
        ready: {
          ...rawSession.tasks.task_1,
          id: "ready",
          title: "Ready work",
          status: "pending",
          dependencies: ["completed"],
        },
        blocked: {
          ...rawSession.tasks.task_1,
          id: "blocked",
          title: "Blocked work",
          status: "pending",
          dependencies: ["missing"],
        },
      },
      swarm_plan: {
        id: "swarm_queues",
        status: "active",
        work_units: [
          {
            id: "wu_completed",
            title: "Completed",
            status: "completed",
            source_task_id: "completed",
            kind: "fanout",
            priority: 1,
          },
          {
            id: "wu_ready",
            title: "Ready",
            status: "pending",
            source_task_id: "ready",
            kind: "fanout",
            dependencies: ["completed"],
            priority: 5,
          },
          {
            id: "wu_blocked",
            title: "Blocked",
            status: "pending",
            source_task_id: "blocked",
            kind: "fanout",
            dependencies: ["missing"],
            priority: 10,
          },
          {
            id: "wu_retry",
            title: "Retry",
            status: "failed",
            source_task_id: "blocked",
            kind: "fanout",
            attempts: 1,
            max_attempts: 3,
            priority: 3,
          },
        ],
      },
    }));

    expect(snapshot.swarm_queues).toMatchObject({
      schema_version: "cowork.swarm_queues.v1",
      plan_id: "swarm_queues",
      generated_at: isoTimestamp,
      parallel_width: 2,
      counts: {
        ready: 1,
        blocked: 1,
        running: 0,
        completed: 1,
        failed_retry: 1,
        cancelled: 0,
      },
      queues: {
        ready: [expect.objectContaining({ id: "wu_ready", blocked_by: [] })],
        blocked: [expect.objectContaining({ id: "wu_blocked", blocked_by: ["missing"] })],
        failed_retry: [expect.objectContaining({ id: "wu_retry" })],
      },
    });
    expect(snapshot.swarm_metrics).toMatchObject({
      schema_version: "cowork.swarm_metrics.v1",
      plan_id: "swarm_queues",
      generated_at: isoTimestamp,
      counts: {
        work_units: 4,
        completed: 1,
        running: 0,
        blocked: 2,
        reducer_units: 0,
        reviewer_units: 0,
      },
    });
    expect(snapshot.swarm_queues.metrics).toMatchObject({
      schema_version: "cowork.swarm_metrics.v1",
      generated_at: isoTimestamp,
    });
  });

  test("projects Python-compatible swarm trace width and empty reducer coverage metrics", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession({
      ...rawSession,
      id: "cw-swarm-trace-width",
      workflow_mode: "swarm",
      tasks: {},
      trace_spans: [
        {
          id: "span_wu_a",
          name: "Work unit started",
          kind: "swarm",
          status: "completed",
          data: { work_unit_id: "wu_a" },
        },
        {
          id: "span_wu_b",
          name: "Work unit started",
          kind: "swarm",
          status: "completed",
          data: { work_unit_id: "wu_b" },
        },
        {
          id: "span_wu_b_duplicate",
          name: "Work unit started",
          kind: "swarm",
          status: "completed",
          data: { work_unit_id: "wu_b" },
        },
      ],
      swarm_plan: {
        id: "swarm_trace_width",
        status: "active",
        work_units: [
          {
            id: "wu_a",
            title: "A",
            status: "pending",
            kind: "fanout",
            dependencies: ["missing_a"],
          },
          {
            id: "wu_b",
            title: "B",
            status: "pending",
            kind: "fanout",
            dependencies: ["missing_b"],
          },
        ],
      },
    }));

    expect(snapshot.swarm_metrics).toMatchObject({
      schema_version: "cowork.swarm_metrics.v1",
      plan_id: "swarm_trace_width",
      fanout_width_observed: 2,
      reducer_coverage: 0,
      counts: {
        completed: 0,
      },
    });
  });

  test("counts reducer source citations regardless of reducer task completion status", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession({
      ...rawSession,
      id: "cw-swarm-reducer-coverage",
      workflow_mode: "swarm",
      tasks: {
        reducer: {
          ...rawSession.tasks.task_1,
          id: "reducer",
          title: "Reduce swarm results",
          status: "pending",
          source_event_id: "swarm_reducer:swarm_reducer_coverage",
          result_data: { source_work_unit_ids: ["wu_a"] },
        },
      },
      swarm_plan: {
        id: "swarm_reducer_coverage",
        status: "reducing",
        work_units: [
          {
            id: "wu_a",
            title: "A",
            status: "completed",
            kind: "fanout",
          },
          {
            id: "wu_b",
            title: "B",
            status: "completed",
            kind: "fanout",
          },
          {
            id: "reducer",
            title: "Reduce swarm results",
            status: "pending",
            kind: "reducer",
            source_task_id: "reducer",
            source_work_unit_ids: ["wu_a", "wu_b"],
          },
        ],
      },
    }));

    expect(snapshot.swarm_metrics).toMatchObject({
      schema_version: "cowork.swarm_metrics.v1",
      plan_id: "swarm_reducer_coverage",
      reducer_coverage: 0.5,
      counts: {
        completed: 2,
        reducer_units: 1,
      },
    });
  });

  test("matches Python critical path depth for cyclic swarm dependencies", () => {
    const snapshot = coworkSessionSnapshot(normalizeCoworkSession({
      ...rawSession,
      id: "cw-swarm-cycle-depth",
      workflow_mode: "swarm",
      swarm_plan: {
        id: "swarm_cycle_depth",
        status: "active",
        work_units: [
          {
            id: "wu_a",
            title: "A",
            status: "pending",
            kind: "fanout",
            dependencies: ["wu_b"],
          },
          {
            id: "wu_b",
            title: "B",
            status: "pending",
            kind: "fanout",
            dependencies: ["wu_a"],
          },
        ],
      },
    }));

    expect(snapshot.swarm_metrics).toMatchObject({
      schema_version: "cowork.swarm_metrics.v1",
      plan_id: "swarm_cycle_depth",
      critical_path_depth: 3,
    });
  });
});
