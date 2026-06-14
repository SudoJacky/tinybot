import { describe, expect, it } from "vitest";

import { coworkSessionSnapshot } from "./coworkSnapshot";
import {
  CoworkService,
  createMemoryCoworkStore,
  DEFAULT_COWORK_AGENT_TOOLS,
  type CoworkServiceStore,
} from "./coworkService";
import type { CoworkSession } from "./coworkTypes";

const fixedNow = "2026-06-12T08:00:00.000Z";

function deterministicIds() {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function serviceWithStore(store: CoworkServiceStore = createMemoryCoworkStore()) {
  return new CoworkService({
    store,
    now: () => fixedNow,
    idGenerator: deterministicIds(),
  });
}

describe("CoworkService", () => {
  it("creates and persists a session with agents, tasks, kickoff thread, lead inbox, defaults, and events", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);

    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Ship the TS Cowork service",
      title: "Cowork TS service",
      workflowMode: "team",
      agents: [{
        id: "Lead Agent",
        name: "Lead Agent",
        role: "Lead",
        goal: "Coordinate migration",
        responsibilities: ["Plan the work"],
      }],
      tasks: [{
        id: "Draft Plan",
        title: "Draft Plan",
        description: "Create the first implementation plan",
        assigned_agent_id: "lead_agent",
      }],
    });

    expect(session.id).toBe("cw_1");
    expect(session.workflow_mode).toBe("team");
    expect(session.workspace_dir).toBe("memory://cowork/cw_1");
    expect(session.current_focus_task).toBe("Draft Plan: Create the first implementation plan");
    expect(session.branches.default.architecture).toBe("team");
    expect(Object.keys(session.agents)).toEqual(["lead_agent"]);
    expect(session.agents.lead_agent.tools).toEqual(DEFAULT_COWORK_AGENT_TOOLS);
    expect(session.agents.lead_agent.communication_policy).toContain("cowork messages");
    expect(session.agents.lead_agent.context_policy).toContain("private summary");
    expect(Object.keys(session.tasks)).toEqual(["draft_plan"]);
    expect(session.tasks.draft_plan.assigned_agent_id).toBe("lead_agent");

    expect(Object.keys(session.threads)).toEqual(["thread_1"]);
    expect(Object.keys(session.messages)).toEqual(["msg_1"]);
    expect(session.messages.msg_1).toMatchObject({
      id: "msg_1",
      thread_id: "thread_1",
      sender_id: "user",
      recipient_ids: ["lead_agent"],
      content: "Goal: Ship the TS Cowork service",
      created_at: fixedNow,
      read_by: ["user"],
    });
    expect(session.threads.thread_1).toMatchObject({
      id: "thread_1",
      topic: "Cowork TS service",
      participant_ids: ["user", "lead_agent"],
      message_ids: ["msg_1"],
      created_at: fixedNow,
      updated_at: fixedNow,
      last_message_at: fixedNow,
    });
    expect(session.agents.lead_agent.inbox).toEqual(["msg_1"]);
    expect(session.events).toEqual([
      expect.objectContaining({
        id: "evt_1",
        type: "session.created",
        actor_id: "user",
      }),
    ]);
    expect(session.trace_spans).toEqual([
      expect.objectContaining({
        id: "span_1",
        kind: "session",
        name: "Session created",
        actor_id: "user",
      }),
    ]);

    await expect(service.getSession("cw_1", "trace-get")).resolves.toMatchObject({ id: "cw_1" });
    await expect(store.readSnapshot("cw_1", "trace-store")).resolves.toMatchObject({ id: "cw_1" });
    expect(coworkSessionSnapshot(session)).toMatchObject({
      id: "cw_1",
      title: "Cowork TS service",
      graph: expect.any(Object),
      trace: expect.any(Array),
      task_dag: expect.any(Object),
    });
  });

  it("creates a session from a valid blueprint and records compile metadata", async () => {
    const service = serviceWithStore();

    const result = await service.createSessionFromBlueprint({
      traceId: "trace-blueprint",
      blueprint: {
        goal: "Research a TS runtime plan",
        title: "Runtime Research",
        workflow_mode: "generator_verifier",
        agents: [
          { id: "Generator", role: "Generator", tools: ["read_file"] },
          { id: "Verifier", role: "Verifier", tools: ["list_dir"] },
        ],
        tasks: [
          { id: "Generate Plan", title: "Generate Plan", assigned_agent_id: "generator" },
          { id: "Verify Plan", title: "Verify Plan", assigned_agent_id: "verifier", dependencies: ["generate_plan"] },
        ],
        budgets: { max_rounds: 4 },
      },
      runtimeState: { requested_by: "test" },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.session).not.toBeNull();
    const session = result.session as CoworkSession;
    expect(session.id).toBe("cw_1");
    expect(session.title).toBe("Runtime Research");
    expect(session.workflow_mode).toBe("generator_verifier");
    expect(session.runtime_state).toEqual({ requested_by: "test" });
    expect(session.blueprint.id).toEqual(expect.any(String));
    expect(session.blueprint_diagnostics).toEqual([]);
    expect(session.agents.generator.source_blueprint_id).toBe("generator");
    expect(session.agents.verifier.source_blueprint_id).toBe("verifier");
    expect(session.tasks.generate_plan.source_blueprint_id).toBe("generate_plan");
    expect(session.tasks.verify_plan.dependencies).toEqual(["generate_plan"]);
    expect(session.events.map((event) => event.type)).toEqual(["session.created", "blueprint.compiled"]);
    expect(session.events[1]).toMatchObject({
      type: "blueprint.compiled",
      actor_id: "user",
      data: {
        blueprint_id: session.blueprint.id,
        diagnostics: [],
      },
    });
    expect(session.trace_spans.map((span) => span.kind)).toEqual(["session", "blueprint"]);
  });

  it("rejects an invalid blueprint without persisting a session", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);

    const result = await service.createSessionFromBlueprint({
      traceId: "trace-invalid-blueprint",
      blueprint: {
        goal: "Invalid",
        agents: [{ id: "lead", tools: ["shell"] }],
      },
    });

    expect(result.session).toBeNull();
    expect(result.diagnostics.some((item) => item.code === "tool_disallowed")).toBe(true);
    await expect(store.listSnapshots("trace-list")).resolves.toEqual([]);
  });

  it("lists active sessions newest first and deletes persisted sessions", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    await store.writeSnapshot({ id: "old", title: "Old", goal: "", status: "active", updated_at: "2026-06-12T07:00:00.000Z" } as CoworkSession, "seed");
    await store.writeSnapshot({ id: "done", title: "Done", goal: "", status: "completed", updated_at: "2026-06-12T09:00:00.000Z" } as CoworkSession, "seed");
    await store.writeSnapshot({ id: "new", title: "New", goal: "", status: "active", updated_at: "2026-06-12T10:00:00.000Z" } as CoworkSession, "seed");

    await expect(service.listSessions("trace-list")).resolves.toEqual([
      expect.objectContaining({ id: "new" }),
      expect.objectContaining({ id: "old" }),
    ]);
    await expect(service.listSessions("trace-list-all", { includeCompleted: true })).resolves.toEqual([
      expect.objectContaining({ id: "new" }),
      expect.objectContaining({ id: "done" }),
      expect.objectContaining({ id: "old" }),
    ]);
    await expect(service.deleteSession("new", "trace-delete")).resolves.toBe(true);
    await expect(service.deleteSession("missing", "trace-delete-missing")).resolves.toBe(false);
    await expect(service.getSession("new", "trace-get-deleted")).resolves.toBeNull();
  });

  it("replays missing events from the native event log when loading snapshots", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_replay",
        title: "Replay",
        goal: "Recover event log",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        events: [{
          id: "evt_snapshot",
          type: "session.created",
          message: "Created from snapshot",
          actor_id: "user",
          created_at: "2026-06-12T09:00:00.000Z",
        }],
      } as CoworkSession]),
      readEvents: async () => [
        {
          id: "evt_snapshot",
          type: "session.created",
          message: "Duplicate from event log",
          actor_id: "user",
          created_at: "2026-06-12T09:00:00.000Z",
        },
        {
          id: "evt_log",
          type: "test.event",
          message: "Recovered from event log",
          actor_id: "system",
          data: { recovered: true },
          created_at: "2026-06-12T09:30:00.000Z",
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_replay", "trace-replay");
    const listed = await service.listSessions("trace-list-replay", { includeCompleted: true });

    expect(loaded?.events.map((event) => event.id)).toEqual(["evt_snapshot", "evt_log"]);
    expect(loaded?.events.at(-1)).toMatchObject({
      type: "test.event",
      message: "Recovered from event log",
      data: { recovered: true },
    });
    expect(listed[0]?.events.map((event) => event.id)).toEqual(["evt_snapshot", "evt_log"]);
  });

  it("recovers interrupted runtime trace spans when loading snapshots", async () => {
    const store = createMemoryCoworkStore([{
      id: "cw_interrupted",
      title: "Interrupted",
      goal: "Recover runtime",
      status: "active",
      updated_at: "2026-06-12T10:00:00.000Z",
      trace_spans: [{
        id: "span_running",
        session_id: "cw_interrupted",
        kind: "agent",
        name: "Running worker",
        status: "running",
        started_at: "2026-06-12T09:00:00.000Z",
        ended_at: "",
        error: "",
        summary: "",
        data: {},
      }],
      runtime_state: {},
    } as CoworkSession]);
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_interrupted", "trace-recover");

    expect(loaded?.trace_spans[0]).toMatchObject({
      id: "span_running",
      status: "failed",
      ended_at: fixedNow,
      error: "Interrupted before the process stopped.",
      summary: "Interrupted runtime span recovered on load.",
    });
    expect(loaded?.runtime_state.interrupted_span_recovery_at).toBe(fixedNow);
  });

  it("replays missing trace spans from the native event log when loading snapshots", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_trace_replay",
        title: "Trace Replay",
        goal: "Recover trace",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        trace_spans: [{
          id: "span_snapshot",
          session_id: "cw_trace_replay",
          kind: "session",
          name: "Snapshot span",
          status: "completed",
          started_at: "2026-06-12T09:00:00.000Z",
          ended_at: "2026-06-12T09:00:01.000Z",
        }],
      } as CoworkSession]),
      readTraceSpans: async () => [
        {
          id: "span_snapshot",
          session_id: "cw_trace_replay",
          kind: "session",
          name: "Duplicate snapshot span",
          status: "completed",
        },
        {
          id: "span_log",
          session_id: "cw_trace_replay",
          kind: "agent",
          name: "Recovered agent span",
          status: "completed",
          actor_id: "lead",
          started_at: "2026-06-12T09:10:00.000Z",
          ended_at: "2026-06-12T09:10:10.000Z",
          summary: "Recovered from trace event log",
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_trace_replay", "trace-span-replay");

    expect(loaded?.trace_spans.map((span) => span.id)).toEqual(["span_snapshot", "span_log"]);
    expect(loaded?.trace_spans.at(-1)).toMatchObject({
      kind: "agent",
      name: "Recovered agent span",
      actor_id: "lead",
      summary: "Recovered from trace event log",
    });
  });

  it("replays missing agent steps from observation event-log records when loading snapshots", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_observation_replay",
        title: "Observation Replay",
        goal: "Recover observations",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        agent_steps: [{
          id: "step_snapshot",
          session_id: "cw_observation_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "lead",
          action_kind: "run_agent",
          status: "completed",
        }],
      } as CoworkSession]),
      readAgentSteps: async () => [
        {
          id: "step_snapshot",
          session_id: "cw_observation_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "lead",
          action_kind: "run_agent",
          status: "completed",
        },
        {
          id: "step_log",
          session_id: "cw_observation_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "reviewer",
          action_kind: "review",
          scheduler_reason: "review gate",
          status: "completed",
          started_at: "2026-06-12T09:10:00.000Z",
          ended_at: "2026-06-12T09:10:20.000Z",
          output_summary: "Approved",
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_observation_replay", "trace-observation-replay");

    expect(loaded?.agent_steps.map((step) => step.id)).toEqual(["step_snapshot", "step_log"]);
    expect(loaded?.agent_steps.at(-1)).toMatchObject({
      agent_id: "reviewer",
      action_kind: "review",
      scheduler_reason: "review gate",
      output_summary: "Approved",
    });
  });

  it("replays missing tool observations onto loaded agent steps", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_tool_replay",
        title: "Tool Replay",
        goal: "Recover tool observations",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        agent_steps: [{
          id: "step_1",
          session_id: "cw_tool_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "lead",
          action_kind: "run_agent",
          status: "completed",
          tool_observations: [{
            id: "toolobs_snapshot",
            step_id: "step_1",
            tool_name: "list_dir",
            result_summary: "Listed files",
          }],
          browser_observations: [],
        }],
      } as CoworkSession]),
      readToolObservations: async () => [
        {
          id: "toolobs_snapshot",
          step_id: "step_1",
          tool_name: "list_dir",
          result_summary: "Duplicate",
        },
        {
          id: "toolobs_log",
          step_id: "step_1",
          tool_name: "read_file",
          calling_agent_id: "lead",
          purpose: "Inspect README",
          result_summary: "Read README",
          status: "completed",
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_tool_replay", "trace-tool-replay");
    const step = loaded?.agent_steps[0];

    expect(step?.tool_observations.map((observation) => observation.id)).toEqual(["toolobs_snapshot", "toolobs_log"]);
    expect(step?.tool_observations.at(-1)).toMatchObject({
      tool_name: "read_file",
      calling_agent_id: "lead",
      purpose: "Inspect README",
      result_summary: "Read README",
    });
  });

  it("replays missing browser observations onto loaded agent steps", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_browser_replay",
        title: "Browser Replay",
        goal: "Recover browser observations",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        agent_steps: [{
          id: "step_1",
          session_id: "cw_browser_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "lead",
          action_kind: "run_agent",
          status: "completed",
          tool_observations: [],
          browser_observations: [{
            id: "browserobs_snapshot",
            step_id: "step_1",
            purpose: "Inspect app",
            result_summary: "Already present",
            sensitive: false,
            redacted: false,
          }],
        }],
      } as CoworkSession]),
      readAgentSteps: async () => [
        {
          id: "step_1",
          session_id: "cw_browser_replay",
          branch_id: "default",
          architecture: "team",
          agent_id: "lead",
          action_kind: "run_agent",
          status: "completed",
        },
      ],
      readBrowserObservations: async () => [
        {
          id: "browserobs_snapshot",
          step_id: "step_1",
          purpose: "Inspect app",
          result_summary: "Duplicate",
          sensitive: false,
          redacted: false,
        },
        {
          id: "browserobs_log",
          step_id: "step_1",
          purpose: "Inspect rendered dashboard",
          resource_ref: "https://example.test/dashboard",
          title: "Dashboard",
          result_summary: "Dashboard loaded",
          status: "completed",
          detail_ref: "detail_1",
          artifact_refs: ["artifact_1"],
          sensitive: true,
          redacted: true,
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_browser_replay", "trace-browser-replay");
    const step = loaded?.agent_steps[0];

    expect(step?.browser_observations.map((observation) => observation.id)).toEqual([
      "browserobs_snapshot",
      "browserobs_log",
    ]);
    expect(step?.browser_observations.at(-1)).toMatchObject({
      purpose: "Inspect rendered dashboard",
      resource_ref: "https://example.test/dashboard",
      title: "Dashboard",
      result_summary: "Dashboard loaded",
      detail_ref: "detail_1",
      artifact_refs: ["artifact_1"],
      sensitive: true,
      redacted: true,
    });
  });

  it("replays missing observation details and sensitive artifacts when loading snapshots", async () => {
    const store = {
      ...createMemoryCoworkStore([{
        id: "cw_detail_replay",
        title: "Detail Replay",
        goal: "Recover observation details",
        status: "active",
        updated_at: "2026-06-12T10:00:00.000Z",
        observation_details: {
          detail_snapshot: {
            id: "detail_snapshot",
            subject_id: "toolobs_snapshot",
            subject_type: "tool_observation",
            state: "available",
            summary: "Existing detail",
            content: "existing content",
            content_type: "text/plain",
          },
        },
        sensitive_artifacts: {},
      } as CoworkSession]),
      readObservationDetails: async () => [
        {
          id: "detail_snapshot",
          subject_id: "toolobs_snapshot",
          subject_type: "tool_observation",
          state: "available",
          summary: "Duplicate detail",
          content: "duplicate content",
          content_type: "text/plain",
        },
        {
          id: "detail_log",
          subject_id: "browserobs_log",
          subject_type: "browser_observation",
          state: "available",
          summary: "Recovered browser detail",
          content: "sensitive browser content",
          content_type: "text/plain",
          sensitivity: "sensitive",
          permitted_agent_ids: ["lead"],
          artifact_refs: ["artifact_1"],
        },
      ],
      readSensitiveArtifacts: async () => [
        {
          id: "sartifact_log",
          source_step_id: "step_1",
          source_observation_id: "browserobs_log",
          summary: "Recovered sensitive artifact",
          artifact_ref: "detail_log",
          sensitivity: "sensitive",
          permitted_agent_ids: ["lead"],
          redacted: true,
        },
      ],
    };
    const service = serviceWithStore(store);

    const loaded = await service.getSession("cw_detail_replay", "trace-detail-replay");

    expect(loaded?.observation_details.detail_snapshot).toMatchObject({
      summary: "Existing detail",
      content: "existing content",
    });
    expect(loaded?.observation_details.detail_log).toMatchObject({
      subject_id: "browserobs_log",
      subject_type: "browser_observation",
      summary: "Recovered browser detail",
      content: "sensitive browser content",
      sensitivity: "sensitive",
      permitted_agent_ids: ["lead"],
    });
    expect(loaded?.sensitive_artifacts.sartifact_log).toMatchObject({
      source_observation_id: "browserobs_log",
      artifact_ref: "detail_log",
      redacted: true,
    });
    await expect(service.getObservationDetail({
      traceId: "trace-detail-replay-owner",
      sessionId: "cw_detail_replay",
      detailId: "detail_log",
      requesterAgentId: "lead",
    })).resolves.toMatchObject({
      id: "detail_log",
      state: "available",
      content: "sensitive browser content",
    });
  });

  it("sends messages through existing threads and wakes recipient inboxes", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Coordinate peer review",
      title: "Review",
      agents: [
        { id: "author", name: "Author", role: "Writer" },
        { id: "reviewer", name: "Reviewer", role: "Reviewer" },
      ],
      tasks: [],
    });

    const result = await service.sendMessage({
      traceId: "trace-message",
      sessionId: session.id,
      senderId: "author",
      recipientIds: ["reviewer", "reviewer", "missing"],
      content: "Please review",
      threadId: "thread_1",
    });

    expect(result.message).toMatchObject({
      id: "msg_2",
      thread_id: "thread_1",
      sender_id: "author",
      recipient_ids: ["reviewer"],
      content: "Please review",
      read_by: ["author"],
    });
    expect(result.session.threads.thread_1).toMatchObject({
      participant_ids: ["user", "author", "reviewer"],
      message_ids: ["msg_1", "msg_2"],
      last_message_at: fixedNow,
    });
    expect(result.session.agents.reviewer.inbox).toEqual(["msg_2"]);
    expect(result.session.agents.reviewer.status).toBe("waiting");
    expect(result.session.events.at(-1)).toMatchObject({
      id: "evt_2",
      type: "message.sent",
      actor_id: "author",
      data: {
        thread_id: "thread_1",
        message_id: "msg_2",
        recipients: ["reviewer"],
        wake_recipients: true,
      },
    });
    await expect(service.getSession(session.id, "trace-get")).resolves.toMatchObject({
      messages: { msg_2: expect.objectContaining({ content: "Please review" }) },
    });
  });

  it("adds tasks, wakes assigned agents, and records traceable task creation", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Plan task mutation",
      title: "Tasks",
      agents: [{ id: "analyst", name: "Analyst", role: "Analyst" }],
      tasks: [],
    });

    const result = await service.addTask({
      traceId: "trace-add-task",
      sessionId: session.id,
      title: "Follow up",
      description: "Check the new path",
      assignedAgentId: "analyst",
      dependencies: ["1"],
      priority: 3,
      expectedOutput: "Findings",
      reviewRequired: true,
      reviewerAgentIds: ["analyst"],
    });

    expect(result.task).toMatchObject({
      id: "task_1",
      title: "Follow up",
      description: "Check the new path",
      assigned_agent_id: "analyst",
      dependencies: ["1"],
      priority: 3,
      expected_output: "Findings",
      review_required: true,
      reviewer_agent_ids: ["analyst"],
      runtime_created: true,
    });
    expect(result.session.agents.analyst.status).toBe("waiting");
    expect(result.session.current_focus_task).toBe("Follow up: Check the new path");
    expect(result.session.events.at(-1)).toMatchObject({
      type: "task.created",
      data: {
        task_id: "task_1",
        assigned_agent_id: "analyst",
        dependencies: ["1"],
        review_required: true,
      },
    });
    expect(result.session.trace_spans.at(-1)).toMatchObject({
      kind: "task",
      name: "Task created",
      actor_id: "analyst",
      data: {
        task_id: "task_1",
        assigned_agent_id: "analyst",
      },
    });
  });

  it("assigns pending tasks to agents and persists the updated session", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Assign work",
      title: "Assign",
      agents: [
        { id: "coordinator", name: "Coordinator", role: "Lead" },
        { id: "analyst", name: "Analyst", role: "Analyst" },
      ],
      tasks: [{ id: "open", title: "Open", description: "Open task" }],
    });

    const result = await service.assignTask({
      traceId: "trace-assign",
      sessionId: session.id,
      taskId: "open",
      agentId: "analyst",
    });

    expect(result.result).toBe("Task 'Open' assigned to Analyst.");
    expect(result.session.tasks.open.assigned_agent_id).toBe("analyst");
    expect(result.session.agents.analyst.status).toBe("waiting");
    expect(result.session.current_focus_task).toBe("Open: Open task");
    expect(result.session.events.at(-1)).toMatchObject({
      type: "task.assigned",
      actor_id: "analyst",
      data: {
        task_id: "open",
        assigned_agent_id: "analyst",
      },
    });
    await expect(service.assignTask({
      traceId: "trace-assign-missing",
      sessionId: session.id,
      taskId: "missing",
      agentId: "analyst",
    })).resolves.toMatchObject({
      result: "Error: task 'missing' not found",
    });
  });

  it("queues failed tasks for retry and wakes assigned agents", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Retry work",
      title: "Retry",
      agents: [{ id: "worker", name: "Worker", role: "Worker" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "worker" }],
    });
    session.tasks.draft.status = "failed";
    session.tasks.draft.error = "failed once";
    session.agents.worker.status = "failed";
    session.status = "completed";
    await store.writeSnapshot(session, "seed-failed");

    const result = await service.retryTask({
      traceId: "trace-retry",
      sessionId: session.id,
      taskId: "draft",
    });

    expect(result.result).toBe("Task 'Draft' queued for retry.");
    expect(result.session.status).toBe("active");
    expect(result.session.tasks.draft).toMatchObject({
      status: "pending",
      error: null,
    });
    expect(result.session.agents.worker.status).toBe("waiting");
    expect(result.session.events.at(-1)).toMatchObject({
      type: "task.retried",
      actor_id: "user",
      data: {
        task_id: "draft",
        previous_status: "failed",
      },
    });
    expect(result.session.trace_spans.at(-1)).toMatchObject({
      kind: "task",
      name: "Task retried",
      actor_id: "user",
      status: "pending",
      data: {
        task_id: "draft",
        previous_status: "failed",
        assigned_agent_id: "worker",
      },
    });
  });

  it("requests task review by creating or reusing a pending review task", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Review work",
      title: "Review",
      agents: [
        { id: "lead", name: "Lead", role: "Lead" },
        { id: "reviewer", name: "Reviewer", role: "Reviewer" },
      ],
      tasks: [{ id: "answer", title: "Answer", description: "Write answer", assigned_agent_id: "lead" }],
    });
    session.tasks.answer.status = "completed";
    session.tasks.answer.result = "The answer";
    await store.writeSnapshot(session, "seed-completed");

    const first = await service.requestTaskReview({
      traceId: "trace-review",
      sessionId: session.id,
      taskId: "answer",
      reviewerAgentId: "reviewer",
    });

    expect(first.reviewTask).toMatchObject({
      id: "task_1",
      title: "Review Answer",
      assigned_agent_id: "reviewer",
      dependencies: ["answer"],
      status: "pending",
    });
    expect(first.session.events.at(-1)).toMatchObject({
      type: "task.review_requested",
      actor_id: "user",
      data: {
        task_id: "answer",
        review_task_id: "task_1",
        reviewer_agent_id: "reviewer",
      },
    });
    expect(first.session.trace_spans.at(-1)).toMatchObject({
      kind: "review",
      name: "Review requested",
      status: "pending",
    });

    const second = await service.requestTaskReview({
      traceId: "trace-review-again",
      sessionId: session.id,
      taskId: "answer",
      reviewerAgentId: "reviewer",
    });

    expect(second.reviewTask.id).toBe("task_1");
    expect(Object.values(second.session.tasks).filter((task) => task.title === "Review Answer")).toHaveLength(1);
  });

  it("exports blueprint and read-only observability projections from persisted sessions", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Inspect cowork state",
      title: "Inspect",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
      tasks: [{
        id: "draft",
        title: "Draft",
        description: "Draft answer",
        assigned_agent_id: "lead",
      }],
      budgets: { max_tokens: 500 },
    });
    session.agent_steps = [{
      id: "step_1",
      session_id: session.id,
      agent_id: "lead",
      task_id: "draft",
      status: "completed",
      started_at: fixedNow,
      ended_at: fixedNow,
      linked_message_ids: ["msg_1"],
      linked_task_ids: ["draft"],
      linked_artifact_refs: ["answer.md"],
      tool_observations: [{ id: "tool_1", name: "read_file", status: "completed" }],
      browser_observations: [],
    }];
    session.observation_details.detail_1 = {
      id: "detail_1",
      subject_id: "tool_1",
      subject_type: "tool_observation",
      state: "available",
      summary: "Read result",
      content: "sensitive content",
      content_type: "text/plain",
      redacted: false,
      sensitivity: "private",
      permitted_agent_ids: ["lead"],
      artifact_refs: ["answer.md"],
      created_at: fixedNow,
    };
    session.artifacts = ["answer.md"];
    await store.writeSnapshot(session, "seed-observability");

    await expect(service.exportBlueprint({ traceId: "trace-export", sessionId: session.id })).resolves.toMatchObject({
      schema_version: "cowork.blueprint.v1",
      goal: "Inspect cowork state",
      title: "Inspect",
      workflow_mode: "team",
      agents: [expect.objectContaining({ id: "lead", name: "Lead", role: "Lead" })],
      tasks: [expect.objectContaining({ id: "draft", title: "Draft", assigned_agent_id: "lead" })],
      budgets: expect.objectContaining({ max_tokens: 500 }),
      metadata: expect.objectContaining({
        exported_from_session_id: session.id,
        runtime_fields_excluded: true,
      }),
    });
    await expect(service.getGraph({ traceId: "trace-graph", sessionId: session.id })).resolves.toMatchObject({
      schema_version: "cowork.graph.v2",
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "session", kind: "session" }),
        expect.objectContaining({ id: "task:draft", kind: "task" }),
      ]),
    });
    await expect(service.getTrace({ traceId: "trace-trace", sessionId: session.id })).resolves.toMatchObject({
      trace: expect.arrayContaining([
        expect.objectContaining({ type: "session.created", source: "event" }),
      ]),
      trace_spans: expect.arrayContaining([
        expect.objectContaining({ kind: "session", name: "Session created" }),
      ]),
      agent_steps: [expect.objectContaining({ id: "step_1", agent_id: "lead" })],
    });
    await expect(service.getAgentActivity({
      traceId: "trace-activity",
      sessionId: session.id,
      agentId: "lead",
      limit: 10,
    })).resolves.toMatchObject({
      available: true,
      session_id: session.id,
      agent: expect.objectContaining({ id: "lead", name: "Lead" }),
      current_task: expect.objectContaining({ id: "draft" }),
      recent_steps: [expect.objectContaining({ id: "step_1" })],
      linked_messages: [expect.objectContaining({ id: "msg_1" })],
      tool_observations: [expect.objectContaining({ id: "tool_1" })],
      artifacts: [expect.objectContaining({ path_or_url: "answer.md" })],
    });
    await expect(service.getObservationDetail({
      traceId: "trace-detail",
      sessionId: session.id,
      detailId: "detail_1",
      requesterAgentId: "reviewer",
    })).resolves.toMatchObject({
      state: "unauthorized",
      id: "detail_1",
      content: "",
      redacted: true,
    });
    await expect(service.getObservationDetail({
      traceId: "trace-detail-owner",
      sessionId: session.id,
      detailId: "detail_1",
      requesterAgentId: "lead",
    })).resolves.toMatchObject({
      state: "available",
      id: "detail_1",
      content: "sensitive content",
    });
    await expect(service.getSummary({ traceId: "trace-summary", sessionId: session.id })).resolves.toMatchObject({
      session_id: session.id,
      title: "Inspect",
      status: "active",
      current_branch_id: "default",
      budget_state: expect.objectContaining({
        limits: expect.objectContaining({ max_tokens: 500 }),
      }),
      counts: {
        agents: 1,
        tasks: 1,
        messages: 1,
        mailbox: 0,
        artifacts: 1,
      },
      current_focus_task: expect.stringContaining("Draft"),
    });
    await expect(service.getTaskDag({ traceId: "trace-dag", sessionId: session.id })).resolves.toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "goal", kind: "goal" }),
        expect.objectContaining({ id: "task:draft", kind: "task" }),
      ]),
      stats: expect.objectContaining({ tasks: 1, artifacts: 0 }),
    });
    await expect(service.getArtifacts({ traceId: "trace-artifacts", sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ id: "artifact_1", path_or_url: "answer.md", kind: "markdown" }),
    ]);
    await expect(service.getOrganization({ traceId: "trace-organization", sessionId: session.id })).resolves.toMatchObject({
      schema_version: "cowork.organization_projection.v1",
      architecture: "team",
      sections: expect.any(Array),
    });
    await expect(service.getQueues({ traceId: "trace-queues", sessionId: session.id })).resolves.toMatchObject({
      schema_version: "cowork.swarm_queues.v1",
      parallel_width: 3,
      available_slots: 3,
      counts: {
        ready: 0,
        blocked: 0,
        running: 0,
        completed: 0,
        failed_retry: 0,
        cancelled: 0,
      },
    });
  });

  it("delivers mailbox envelopes through the persisted service session", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Persist mailbox runtime",
      title: "Mailbox",
      agents: [
        { id: "coordinator", name: "Coordinator", role: "Lead" },
        { id: "researcher", name: "Researcher", role: "Research" },
      ],
      tasks: [],
    });

    const result = await service.deliverEnvelope({
      traceId: "trace-mailbox",
      sessionId: session.id,
      envelope: {
        sender_id: "coordinator",
        recipient_ids: ["researcher"],
        content: "Please verify this result.",
        requires_reply: true,
        correlation_id: "verify-1",
      },
    });

    expect(result.message).toMatchObject({
      id: "msg_2",
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
    });
    expect(result.record).toMatchObject({
      id: "env_1",
      message_id: "msg_2",
      status: "delivered",
      requires_reply: true,
      correlation_id: "verify-1",
    });
    await expect(store.readSnapshot(session.id, "trace-read")).resolves.toMatchObject({
      mailbox: {
        env_1: expect.objectContaining({ message_id: "msg_2" }),
      },
      agents: {
        researcher: expect.objectContaining({
          inbox: ["msg_2"],
          status: "waiting",
        }),
      },
    });
  });

  it("persists mailbox read and deadline expiration updates", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Persist mailbox lifecycle",
      title: "Mailbox lifecycle",
      agents: [
        { id: "coordinator", name: "Coordinator", role: "Lead" },
        { id: "researcher", name: "Researcher", role: "Research" },
      ],
      tasks: [],
    });

    await service.deliverEnvelope({
      traceId: "trace-mailbox-read",
      sessionId: session.id,
      envelope: {
        sender_id: "coordinator",
        recipient_ids: ["researcher"],
        content: "Read this.",
        requires_reply: true,
      },
    });

    const read = await service.markMailboxMessagesRead({
      traceId: "trace-read",
      sessionId: session.id,
      agentId: "researcher",
    });

    expect(read.messages).toEqual([expect.objectContaining({ id: "msg_2" })]);
    expect(read.session).toMatchObject({
      messages: {
        msg_2: expect.objectContaining({ read_by: ["coordinator", "researcher"] }),
      },
      mailbox: {
        env_1: expect.objectContaining({ status: "read", read_by: ["researcher"] }),
      },
      agents: {
        researcher: expect.objectContaining({ inbox: [] }),
      },
    });

    const expiring = await service.deliverEnvelope({
      traceId: "trace-mailbox-expire",
      sessionId: session.id,
      envelope: {
        sender_id: "researcher",
        recipient_ids: ["coordinator"],
        content: "Deadline.",
        requires_reply: true,
        deadline_round: 0,
        correlation_id: "deadline-1",
      },
    });
    expiring.session.rounds = 0;
    await store.writeSnapshot(expiring.session, "seed-round");

    const expired = await service.expireMailboxRecords({
      traceId: "trace-expire",
      sessionId: session.id,
    });

    expect(expired.records).toEqual([expect.objectContaining({ id: "env_2", status: "expired" })]);
    await expect(store.readSnapshot(session.id, "trace-read-expired")).resolves.toMatchObject({
      mailbox: {
        env_2: expect.objectContaining({ status: "expired", correlation_id: "deadline-1" }),
      },
      events: expect.arrayContaining([
        expect.objectContaining({ type: "mailbox.expired" }),
      ]),
    });
  });

  it("persists stale blocker escalation updates", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Escalate stale blockers",
      title: "Escalation",
      agents: [
        { id: "coordinator", name: "Coordinator", role: "Lead" },
        { id: "researcher", name: "Researcher", role: "Research" },
        { id: "reviewer", name: "Reviewer", role: "Quality reviewer", responsibilities: ["Verify risk"] },
      ],
      tasks: [],
    });
    const delivered = await service.deliverEnvelope({
      traceId: "trace-mailbox-blocker",
      sessionId: session.id,
      envelope: {
        sender_id: "researcher",
        recipient_ids: ["coordinator"],
        content: "Blocked on verification.",
        requires_reply: true,
        blocking_task_id: "task_x",
        escalate_after_rounds: 1,
      },
    });
    delivered.session.rounds = 1;
    await store.writeSnapshot(delivered.session, "seed-round");

    const escalated = await service.escalateStaleBlockers({
      traceId: "trace-escalate",
      sessionId: session.id,
    });

    expect(escalated.records).toEqual([expect.objectContaining({ id: "env_1", escalated_at: fixedNow })]);
    await expect(store.readSnapshot(session.id, "trace-read-escalated")).resolves.toMatchObject({
      mailbox: {
        env_1: expect.objectContaining({ escalated_at: fixedNow }),
      },
      messages: {
        msg_3: expect.objectContaining({
          sender_id: "user",
          recipient_ids: ["reviewer"],
          content: expect.stringContaining("Escalate stale blocker env_1 from researcher"),
        }),
      },
      agents: {
        reviewer: expect.objectContaining({ inbox: ["msg_3"] }),
      },
      events: expect.arrayContaining([
        expect.objectContaining({ type: "mailbox.stale_blocker", actor_id: "reviewer" }),
      ]),
    });
  });

  it("pauses and resumes sessions with the current branch status", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Control session",
      title: "Control",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });

    const paused = await service.pauseSession({ traceId: "trace-pause", sessionId: session.id });
    expect(paused.result).toBe(`Paused cowork session ${session.id}.`);
    expect(paused.session.status).toBe("paused");
    expect(paused.session.branches.default.status).toBe("paused");
    expect(paused.session.events.at(-1)).toMatchObject({
      type: "session.paused",
      message: "Cowork session paused",
    });

    const resumed = await service.resumeSession({ traceId: "trace-resume", sessionId: session.id });
    expect(resumed.result).toBe(`Resumed cowork session ${session.id}.`);
    expect(resumed.session.status).toBe("active");
    expect(resumed.session.branches.default.status).toBe("active");
    expect(resumed.session.events.at(-1)).toMatchObject({
      type: "session.resumed",
      message: "Cowork session resumed",
    });
  });

  it("records emergency stop as paused state, stop reason, trace, and agent step", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Stop safely",
      title: "Stop",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });

    const result = await service.emergencyStopSession({
      traceId: "trace-stop",
      sessionId: session.id,
      reason: "Unsafe to continue",
    });

    expect(result.session.status).toBe("paused");
    expect(result.session.branches.default.status).toBe("paused");
    expect(result.session.stop_reason).toBe("emergency_stop");
    expect(result.agentStep).toMatchObject({
      id: "step_1",
      session_id: session.id,
      branch_id: "default",
      agent_id: "scheduler",
      action_kind: "emergency_stop",
      scheduler_reason: "Unsafe to continue",
      status: "stopped",
      input_summary: "Unsafe to continue",
      output_summary: "Emergency Stop recorded; future scheduling is paused.",
    });
    expect(result.session.events.at(-1)).toMatchObject({
      type: "scheduler.stop",
      actor_id: "scheduler",
      data: {
        stop_reason: "emergency_stop",
        control_scope: "emergency_stop",
        actor_id: "user",
        branch_id: "default",
      },
    });
    expect(result.session.trace_spans.at(-1)).toMatchObject({
      kind: "scheduler",
      name: "Stop reason",
      actor_id: "scheduler",
      data: {
        stop_reason: "emergency_stop",
      },
    });
  });

  it("updates budget limits and returns budget state", async () => {
    const service = serviceWithStore();
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Budget",
      title: "Budget",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
      budgets: { max_rounds_per_run: 2 },
    });

    const result = await service.updateBudget({
      traceId: "trace-budget",
      sessionId: session.id,
      budgets: { parallel_width: 5, max_tokens: 1200 },
    });

    expect(result.budget).toMatchObject({
      limits: {
        max_rounds_per_run: 2,
        parallel_width: 5,
        max_tokens: 1200,
      },
      usage: {
        rounds: 0,
        tokens_total: 0,
        stop_reason: "",
      },
      remaining: {
        max_rounds_per_run: 2,
        parallel_width: 5,
        max_tokens: 1200,
      },
      stop_reason: "",
    });
    expect(result.session.budget_limits).toMatchObject({
      max_rounds_per_run: 2,
      parallel_width: 5,
      max_tokens: 1200,
    });
    expect(result.session.events.at(-1)).toMatchObject({
      type: "budget.updated",
      actor_id: "user",
      data: {
        budget: result.budget,
      },
    });
  });

  it("derives a branch while preserving completed source branch state and result", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Compare implementation paths",
      title: "Branches",
      workflowMode: "adaptive_starter",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    });
    session.status = "completed";
    session.current_focus_task = "Finished source branch";
    session.final_draft = "Source branch result";
    session.artifacts = ["a.md", "b.md"];
    session.completion_decision = { ready: true };
    session.tasks.draft.status = "completed";
    session.tasks.draft.confidence = 0.8;
    await store.writeSnapshot(session, "seed-completed-branch");

    const result = await service.deriveBranch({
      traceId: "trace-derive",
      sessionId: session.id,
      sourceBranchId: "default",
      targetArchitecture: "team",
      reason: "Need a team variant",
      title: "Team branch",
      inheritedContextSummary: "Carry over source findings",
    });

    expect(result.branch).toMatchObject({
      id: "br_1",
      title: "Team branch",
      architecture: "team",
      status: "active",
      source_branch_id: "default",
      derivation_reason: "Need a team variant",
      inherited_context_summary: "Carry over source findings",
      runtime_state: {
        current_focus_task: "Carry over source findings",
        source_branch_status: "completed",
      },
    });
    expect(result.session.current_branch_id).toBe("br_1");
    expect(result.session.workflow_mode).toBe("team");
    expect(result.session.status).toBe("active");
    expect(result.session.current_focus_task).toBe("Carry over source findings");
    expect(result.session.branches.default).toMatchObject({
      status: "completed",
      completion_decision: { ready: true },
      runtime_state: {
        current_focus_task: "Finished source branch",
        rounds: 0,
        no_progress_rounds: 0,
      },
      branch_result: {
        id: "brres_1",
        source_branch_id: "default",
        source_architecture: "adaptive_starter",
        summary: "Source branch result",
        artifacts: ["a.md", "b.md"],
        decision: { ready: true },
        confidence: 0.8,
        result_type: "branch",
      },
    });
    expect(result.session.stage_records).toEqual([
      expect.objectContaining({
        id: "stage_1",
        source_branch_id: "default",
        target_branch_id: "br_1",
        source_architecture: "adaptive_starter",
        target_architecture: "team",
        derivation_reason: "Need a team variant",
        inherited_context_summary: "Carry over source findings",
        artifact_refs: ["a.md", "b.md"],
      }),
    ]);
    expect(result.session.events.map((event) => event.type)).toEqual([
      "session.created",
      "branch.result.created",
      "branch.derived",
    ]);
    await expect(store.readSnapshot(session.id, "trace-read")).resolves.toMatchObject({
      current_branch_id: "br_1",
      branches: {
        default: expect.objectContaining({ branch_result: expect.objectContaining({ id: "brres_1" }) }),
        br_1: expect.objectContaining({ source_branch_id: "default" }),
      },
    });
  });

  it("selects and merges branch results into an explicit session final result", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Pick a final result",
      title: "Final",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });
    session.branches.default.branch_result = {
      id: "brres_default",
      source_branch_id: "default",
      source_architecture: "adaptive_starter",
      summary: "Default summary",
      artifacts: ["default.md"],
      decision: { default: true },
      confidence: 0.5,
      result_type: "branch",
      source_result_ids: [],
      created_at: fixedNow,
    };
    session.branches.team = {
      id: "team",
      title: "Team branch",
      architecture: "team",
      status: "completed",
      topology_reference: { branch_id: "team", architecture: "team" },
      source_branch_id: "default",
      source_stage_record_id: "stage_1",
      derivation_event_id: "evt_2",
      derivation_reason: "Team variant",
      inherited_context_summary: "Context",
      runtime_state: {},
      completion_decision: { team: true },
      branch_result: {
        id: "brres_team",
        source_branch_id: "team",
        source_architecture: "team",
        summary: "Team summary",
        artifacts: ["team.md", "default.md"],
        decision: { team: true },
        confidence: 0.9,
        result_type: "branch",
        source_result_ids: [],
        created_at: fixedNow,
      },
      created_at: fixedNow,
      updated_at: fixedNow,
    };
    await store.writeSnapshot(session, "seed-results");

    const selected = await service.selectSessionFinalResult({
      traceId: "trace-select",
      sessionId: session.id,
      branchId: "team",
      resultId: "brres_team",
    });

    expect(selected.finalResult).toMatchObject({
      id: "final_1",
      source: "selected_branch_result",
      selected_branch_id: "team",
      selected_result_id: "brres_team",
      source_branch_ids: ["team"],
      source_result_ids: ["brres_team"],
      summary: "Team summary",
      artifacts: ["team.md", "default.md"],
      decision: { team: true },
      confidence: 0.9,
    });
    expect(selected.result).toBe("Selected branch result 'brres_team' as the session final result.");

    const merged = await service.mergeBranchResults({
      traceId: "trace-merge",
      sessionId: session.id,
      branchIds: ["default", "team", "team"],
    });

    expect(merged.finalResult).toMatchObject({
      id: "final_2",
      source: "branch_merge",
      source_branch_ids: ["default", "team"],
      source_result_ids: ["brres_default", "brres_team"],
      summary: "## Default branch\nDefault summary\n\n## Team branch\nTeam summary",
      artifacts: ["default.md", "team.md"],
      decision: {
        operation: "branch_merge",
        source_branch_ids: ["default", "team"],
        source_result_ids: ["brres_default", "brres_team"],
        created_at: fixedNow,
      },
      confidence: 0.7,
    });
    expect(merged.result).toBe("Merged 2 branch results into a candidate session final result.");
    await expect(service.selectSessionFinalResult({
      traceId: "trace-select-missing",
      sessionId: session.id,
      branchId: "missing",
    })).resolves.toMatchObject({
      result: "Error: branch 'missing' not found.",
      finalResult: null,
    });
  });
});
