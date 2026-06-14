import { describe, expect, it } from "vitest";

import { AgentRunner } from "../agent/agentRunner";
import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import type { ToolCallDelta } from "../model/streamParser";
import { ToolRegistry } from "../tools/toolRegistry";
import { CoworkAgentRuntime, selectReadyCoworkAgentCandidates } from "./coworkAgentRuntime";
import { CoworkService, createMemoryCoworkStore, type CoworkIdGenerator, type CoworkServiceStore } from "./coworkService";

const fixedNow = "2026-06-12T10:00:00.000Z";
const defaultStreamDeltas: ToolCallDelta[] = [{
  index: 0,
  deltaText: "{\"streamed\":true}",
  toolCallId: "stream-call",
  toolName: "stream_tool",
}];

function deterministicIds(): CoworkIdGenerator {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

class QueueProvider implements ModelProvider {
  readonly messages: AgentMessage[][] = [];
  readonly options: ModelRequestOptions[] = [];

  constructor(
    private readonly responses: ModelResponse[],
    private readonly streamDeltasByResponse: ToolCallDelta[][] = [defaultStreamDeltas],
  ) {}

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    options.onContentDelta?.("stream content");
    options.onReasoningDelta?.("stream reasoning");
    const streamDeltas = this.streamDeltasByResponse.shift() ?? [];
    for (const delta of streamDeltas) {
      options.onToolCallDelta?.(delta);
    }
    return response;
  }
}

async function seedRuntime(provider: ModelProvider): Promise<{
  store: CoworkServiceStore;
  runtime: CoworkAgentRuntime;
  tools: ToolRegistry;
  appendedEvents: Array<{ sessionId: string; event: Record<string, unknown>; traceId: string }>;
}> {
  const store = createMemoryCoworkStore() as CoworkServiceStore & {
    appendEvent?: (sessionId: string, event: Record<string, unknown>, traceId: string) => Promise<string>;
  };
  const appendedEvents: Array<{ sessionId: string; event: Record<string, unknown>; traceId: string }> = [];
  store.appendEvent = async (sessionId, event, traceId) => {
    appendedEvents.push({ sessionId, event: { ...event }, traceId });
    return typeof event.id === "string" ? event.id : "";
  };
  const idGenerator = deterministicIds();
  const service = new CoworkService({
    store,
    now: () => fixedNow,
    idGenerator,
  });
  await service.createSession({
    traceId: "seed",
    goal: "Migrate Cowork agent runtime",
    title: "Agent runtime",
    workflowMode: "team",
    agents: [{ id: "lead", name: "Lead", role: "Coordinator", goal: "Coordinate work" }],
    tasks: [{ id: "draft", title: "Draft", description: "Draft the TS agent runtime", assigned_agent_id: "lead" }],
  });
  const tools = new ToolRegistry();
  const runner = new AgentRunner({
    provider,
    tools,
  });
  return {
    store,
    tools,
    runtime: new CoworkAgentRuntime({
      store,
      runner,
      tools,
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    }),
    appendedEvents,
  };
}

describe("CoworkAgentRuntime", () => {
  it("allocates each unassigned ready shared task to one active candidate", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.researcher = {
      ...session.agents.lead,
      id: "researcher",
      name: "Researcher",
      role: "Research",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
    };
    session.agents.lead.inbox = [];
    session.tasks = {
      shared: {
        id: "shared",
        title: "Shared task",
        description: "Any active agent can claim this task.",
        assigned_agent_id: null,
        status: "pending",
        dependencies: [],
        result: null,
        result_data: {},
        confidence: null,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    const selection = selectReadyCoworkAgentCandidates(session, 2);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["lead"]);
    expect(selection.candidateScores).toEqual({ lead: 28 });
  });

  it("orders team ready agents by Python readiness scores before applying the limit", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.worker = {
      ...session.agents.lead,
      id: "worker",
      name: "Worker",
      role: "Implementation",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
    };
    session.tasks.implement = {
      ...session.tasks.draft,
      id: "implement",
      title: "Implement",
      description: "Implement the TS migration slice.",
      assigned_agent_id: "worker",
      status: "pending",
      dependencies: [],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["worker"]);
    expect(selection.candidateScores).toMatchObject({
      lead: 63,
      worker: 65,
    });
  });

  it("selects agents with pending reply mailbox records even when inbox is empty like Python", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.lead.inbox = [];
    session.agents.lead.current_task_id = null;
    session.agents.lead.status = "idle";
    session.tasks = {};
    session.mailbox.reply_1 = {
      id: "reply_1",
      sender_id: "worker",
      recipient_ids: ["lead"],
      content: "Need a lead decision before continuing.",
      kind: "request",
      status: "delivered",
      requires_reply: true,
      request_type: "decision",
      thread_id: "thread_1",
      correlation_id: "corr_1",
      reply_to_message_id: "",
      blocking_task_id: "draft",
      priority: 80,
      created_at: fixedNow,
      updated_at: fixedNow,
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["lead"]);
    expect(selection.candidateScores).toEqual({ lead: 100 });
  });

  it("expires overdue mailbox records before selecting ready agents like Python", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.rounds = 3;
    session.agents.lead.inbox = [];
    session.agents.lead.current_task_id = null;
    session.agents.lead.status = "idle";
    session.tasks = {};
    session.mailbox.reply_1 = {
      id: "reply_1",
      sender_id: "worker",
      recipient_ids: ["lead"],
      content: "Need a lead decision before continuing.",
      kind: "request",
      status: "delivered",
      requires_reply: true,
      request_type: "decision",
      thread_id: "thread_1",
      correlation_id: "corr_1",
      reply_to_message_id: "",
      blocking_task_id: "draft",
      priority: 80,
      deadline_round: 2,
      created_at: fixedNow,
      updated_at: fixedNow,
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents).toEqual([]);
    expect(selection.candidateScores).toEqual({});
    expect(session.mailbox.reply_1.status).toBe("expired");
    expect(session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "mailbox.expired",
        message: "Mailbox envelope reply_1 expired",
        actor_id: "worker",
        data: expect.objectContaining({
          envelope_id: "reply_1",
          correlation_id: "corr_1",
        }),
      }),
    ]));
  });

  it("escalates stale mailbox blockers before selecting ready agents like Python", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.rounds = 3;
    session.agents.lead.inbox = [];
    session.agents.lead.current_task_id = null;
    session.agents.lead.status = "idle";
    session.tasks = {};
    session.mailbox.reply_1 = {
      id: "reply_1",
      sender_id: "worker",
      recipient_ids: ["worker"],
      content: "Need implementation details before continuing.",
      kind: "request",
      status: "delivered",
      requires_reply: true,
      request_type: "decision",
      thread_id: "thread_1",
      correlation_id: "corr_1",
      reply_to_message_id: "",
      blocking_task_id: "draft",
      priority: 80,
      escalate_after_rounds: 2,
      created_at: fixedNow,
      updated_at: fixedNow,
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["lead"]);
    expect(session.mailbox.reply_1.escalated_at).toEqual(expect.any(String));
    expect(session.agents.lead.inbox).toHaveLength(1);
    expect(session.messages[session.agents.lead.inbox[0]]).toEqual(expect.objectContaining({
      sender_id: "user",
      recipient_ids: ["lead"],
      content: "Escalate stale blocker reply_1 from worker: Need implementation details before continuing.",
      thread_id: "thread_1",
    }));
    expect(session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "mailbox.stale_blocker",
        message: "Mailbox envelope reply_1 escalated as a stale blocker",
        actor_id: "lead",
        data: expect.objectContaining({
          envelope_id: "reply_1",
          target_agent_id: "lead",
          blocking_task_id: "draft",
        }),
      }),
    ]));
  });

  it("does not select done agents even when they still have inbox work", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.lead.status = "done";
    session.agents.lead.inbox = ["msg_1"];
    session.messages.msg_1 = {
      id: "msg_1",
      thread_id: "thread_1",
      sender_id: "user",
      recipient_ids: ["lead"],
      content: "Follow-up after completion.",
      created_at: fixedNow,
      read_by: [],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents).toEqual([]);
    expect(selection.candidateScores).toEqual({});
  });

  it("does not select agents when the session is not active", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.status = "paused";

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents).toEqual([]);
    expect(selection.candidateScores).toEqual({});
  });

  it("does not fall back to team selection for swarm sessions without ready swarm units", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents).toEqual([]);
    expect(selection.candidateScores).toEqual({});
    expect(selection.reasonProfile).toBe("swarm workstream readiness scoring");
  });

  it("does not select more swarm agents when parallel width is already saturated", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";
    session.budget_limits = { ...session.budget_limits, parallel_width: 1 };
    session.agents.lead.status = "working";
    session.agents.researcher = {
      ...session.agents.lead,
      id: "researcher",
      name: "Researcher",
      role: "Research",
      status: "waiting",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
    };
    session.tasks.research = {
      ...session.tasks.draft,
      id: "research",
      title: "Research",
      description: "Research the TS swarm scheduler",
      assigned_agent_id: "researcher",
      status: "pending",
      dependencies: [],
    };
    session.swarm_plan = {
      id: "swarm_1",
      status: "running",
      work_units: [{
        id: "wu_research",
        title: "Research",
        description: "Research the TS swarm scheduler",
        source_task_id: "research",
        assigned_agent_id: "researcher",
        workstream: "runtime",
        status: "ready",
        dependencies: [],
        priority: 5,
      }],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 10);

    expect(selection.agents).toEqual([]);
    expect(selection.candidateScores).toEqual({});
    expect(selection.reasonProfile).toBe("swarm workstream readiness scoring");
  });

  it("skips duplicate swarm work-unit signatures during agent selection", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";
    session.budget_limits = { ...session.budget_limits, parallel_width: 2 };
    session.agents.a = {
      ...session.agents.lead,
      id: "a",
      name: "A",
      role: "Worker",
      status: "waiting",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
    };
    session.agents.b = {
      ...session.agents.a,
      id: "b",
      name: "B",
    };
    session.tasks = {
      same_a: {
        ...session.tasks.draft,
        id: "same_a",
        title: "Same",
        description: "same input",
        assigned_agent_id: "a",
        status: "pending",
        dependencies: [],
      },
      same_b: {
        ...session.tasks.draft,
        id: "same_b",
        title: "Same",
        description: "same input",
        assigned_agent_id: "b",
        status: "pending",
        dependencies: [],
      },
    };
    session.swarm_plan = {
      id: "swarm_1",
      status: "running",
      work_units: [
        {
          id: "same_a",
          title: "Same",
          description: "same input",
          input: { topic: "x" },
          expected_output_schema: { answer: "string" },
          completion_criteria: ["answer"],
          assigned_agent_id: "a",
          dependencies: [],
          status: "ready",
          priority: 0,
        },
        {
          id: "same_b",
          title: "Same",
          description: "same input",
          input: { topic: "x" },
          expected_output_schema: { answer: "string" },
          completion_criteria: ["answer"],
          assigned_agent_id: "b",
          dependencies: [],
          status: "ready",
          priority: 0,
        },
      ],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 2);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["a"]);
    expect(Object.keys(selection.candidateScores)).toEqual(["a"]);
  });

  it("selects failed swarm work units that still have retry attempts", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";
    session.budget_limits = { ...session.budget_limits, parallel_width: 1 };
    session.swarm_plan = {
      id: "swarm_1",
      status: "running",
      work_units: [{
        id: "wu_retry",
        title: "Retry research",
        description: "Retry the failed research lane",
        source_task_id: "draft",
        assigned_agent_id: "lead",
        workstream: "runtime",
        status: "failed",
        attempts: 1,
        max_attempts: 3,
        dependencies: [],
        priority: 5,
      }],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["lead"]);
    expect(selection.candidateScores.lead).toEqual(expect.objectContaining({
      work_unit_id: "wu_retry",
      status: "failed",
    }));
  });

  it("selects failed retry swarm units when their source task is failed", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";
    session.tasks.draft.status = "failed";
    session.tasks.draft.error = "model timeout";
    session.budget_limits = { ...session.budget_limits, parallel_width: 1 };
    session.swarm_plan = {
      id: "swarm_1",
      status: "running",
      work_units: [{
        id: "wu_retry_failed_task",
        title: "Retry failed task",
        description: "Retry the failed task lane",
        source_task_id: "draft",
        assigned_agent_id: "lead",
        workstream: "runtime",
        status: "failed",
        attempts: 1,
        max_attempts: 3,
        dependencies: [],
        priority: 5,
      }],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["lead"]);
    expect(selection.candidateScores.lead).toEqual(expect.objectContaining({
      work_unit_id: "wu_retry_failed_task",
      source_task_id: "draft",
      status: "failed",
    }));
  });

  it("prefers ready swarm work before failed retry work", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "test");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.workflow_mode = "swarm";
    session.budget_limits = { ...session.budget_limits, parallel_width: 1 };
    session.agents.a = {
      ...session.agents.lead,
      id: "a",
      name: "A",
      role: "Worker",
      status: "waiting",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
    };
    session.agents.b = {
      ...session.agents.a,
      id: "b",
      name: "B",
    };
    session.tasks = {
      ready: {
        ...session.tasks.draft,
        id: "ready",
        title: "Ready lane",
        description: "Fresh ready work",
        assigned_agent_id: "a",
        status: "pending",
        dependencies: [],
      },
      retry: {
        ...session.tasks.draft,
        id: "retry",
        title: "Retry lane",
        description: "Retry failed work",
        assigned_agent_id: "b",
        status: "failed",
        dependencies: [],
        error: "model timeout",
      },
    };
    session.swarm_plan = {
      id: "swarm_1",
      status: "running",
      work_units: [
        {
          id: "wu_ready",
          title: "Ready lane",
          description: "Fresh ready work",
          source_task_id: "ready",
          assigned_agent_id: "a",
          workstream: "runtime",
          status: "ready",
          dependencies: [],
          priority: 1,
        },
        {
          id: "wu_retry",
          title: "Retry lane",
          description: "Retry failed work",
          source_task_id: "retry",
          assigned_agent_id: "b",
          workstream: "runtime",
          status: "failed",
          attempts: 1,
          max_attempts: 3,
          dependencies: [],
          priority: 10,
        },
      ],
    };

    const selection = selectReadyCoworkAgentCandidates(session, 1);

    expect(selection.agents.map((agent) => agent.id)).toEqual(["a"]);
    expect(selection.candidateScores.a).toEqual(expect.objectContaining({
      work_unit_id: "wu_ready",
      status: "ready",
    }));
  });

  it("runs one agent round and applies completed task progress", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Draft completed for the user.",
        private_note: "Used the TypeScript runtime path.",
        completed_task_ids: ["draft"],
        completed_task_results: [{
          task_id: "draft",
          answer: "Implemented a minimal agent runtime.",
          findings: ["AgentRunner can drive cowork rounds."],
          risks: ["Internal cowork tools are still pending."],
          confidence: 0.82,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);

    const result = await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(result.result).toContain("Lead finished with action complete");
    expect(provider.messages[0][0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Lead"),
    });
    expect(provider.messages[0][1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Draft"),
    });
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.draft).toMatchObject({
      status: "completed",
      result: expect.stringContaining("Implemented a minimal agent runtime."),
      confidence: 0.82,
    });
    expect(saved?.agents.lead).toMatchObject({
      status: "done",
      private_summary: expect.stringContaining("Used the TypeScript runtime path."),
      current_task_id: null,
    });
    expect(saved?.events.map((event) => event.type)).toContain("agent.started");
    expect(saved?.events.map((event) => event.type)).toContain("task.completed");
    expect(saved?.agent_steps).toEqual([expect.objectContaining({
      agent_id: "lead",
      status: "completed",
      linked_task_ids: ["draft"],
      detail_ref: "step_1",
      summary: expect.objectContaining({
        id: "summary:step_1",
        step_id: "step_1",
        purpose: "Scheduler selected lead for Draft",
        action_kind: "agent_run",
        input_summary: "Draft the TS agent runtime",
        outcome_summary: "Draft completed for the user.",
        next_effect: "Updated task(s): draft",
        has_full_detail: true,
        detail_ref: "step_1",
        redacted: false,
        created_at: fixedNow,
      }),
    })]);
    expect(seeded.appendedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          category: "trace",
          type: "trace.span_recorded",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            span: expect.objectContaining({
              kind: "agent",
              name: "Run Lead",
              status: "completed",
              actor_id: "lead",
              summary: "Lead finished with action complete",
            }),
          }),
        }),
      }),
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          id: "step_1",
          type: "agent_step.finished",
          category: "observation",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            agent_step: expect.objectContaining({
              id: "step_1",
              status: "completed",
              summary: expect.objectContaining({ outcome_summary: "Draft completed for the user." }),
            }),
          }),
        }),
      }),
    ]));
    expect(seeded.appendedEvents.filter((item) => item.event.category === "trace")).toHaveLength(1);
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent", name: "Run Lead", status: "completed" }),
    ]));
  });

  it("persists failed agent and task state when the runner raises like Python", async () => {
    const provider = new QueueProvider([]);
    const seeded = await seedRuntime(provider);

    const result = await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(result.result).toContain("Lead failed: no queued model response");
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.lead).toMatchObject({
      status: "failed",
      current_task_id: null,
      current_task_title: null,
    });
    expect(saved?.tasks.draft).toMatchObject({
      status: "failed",
      error: "no queued model response",
      result: "no queued model response",
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task.failed",
        actor_id: "lead",
        data: expect.objectContaining({ task_id: "draft", error: "no queued model response" }),
      }),
      expect.objectContaining({
        type: "agent.failed",
        actor_id: "lead",
        message: "Lead failed: no queued model response",
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "agent",
        name: "Run Lead",
        status: "failed",
        error: "no queued model response",
      }),
      expect.objectContaining({
        kind: "agent",
        name: "Agent failed",
        status: "failed",
        error: "no queued model response",
      }),
    ]));
    expect(saved?.agent_steps).toEqual([expect.objectContaining({
      agent_id: "lead",
      status: "failed",
      error: "no queued model response",
      linked_task_ids: ["draft"],
      summary: expect.objectContaining({
        id: "summary:step_1",
        step_id: "step_1",
        purpose: "Scheduler selected lead for Draft",
        action_kind: "agent_run",
        input_summary: "Draft the TS agent runtime",
        outcome_summary: "no queued model response",
        next_effect: "Updated task(s): draft",
        has_full_detail: false,
        detail_ref: "",
        redacted: false,
        created_at: fixedNow,
      }),
    })]);
    expect(seeded.appendedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          category: "trace",
          type: "trace.span_recorded",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            span: expect.objectContaining({
              kind: "agent",
              name: "Run Lead",
              status: "failed",
              actor_id: "lead",
              summary: "Lead failed",
              error: "no queued model response",
            }),
          }),
        }),
      }),
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          category: "trace",
          type: "trace.span_recorded",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            span: expect.objectContaining({
              kind: "agent",
              name: "Agent failed",
              status: "failed",
              actor_id: "lead",
              summary: "Lead failed",
              error: "no queued model response",
            }),
          }),
        }),
      }),
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          id: "step_1",
          type: "agent_step.finished",
          category: "observation",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            agent_step: expect.objectContaining({
              id: "step_1",
              status: "failed",
              error: "no queued model response",
              summary: expect.objectContaining({ outcome_summary: "no queued model response" }),
            }),
          }),
        }),
      }),
    ]));
    expect(seeded.appendedEvents.filter((item) => item.event.category === "trace")).toHaveLength(2);
  });

  it("starts and completes the associated swarm work unit during an agent round", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Research lane completed.",
        private_note: "Captured swarm lifecycle state.",
        completed_task_ids: ["draft"],
        completed_task_results: [{
          task_id: "draft",
          answer: "Swarm work unit is now backed by TS lifecycle state.",
          evidence: ["agent step linked the unit"],
          risks: ["review gate still follows later"],
          confidence: 0.74,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      swarm_plan: {
        id: "swarm_1",
        status: "running",
        work_units: [{
          id: "wu_draft",
          title: "Draft swarm migration",
          description: "Draft the TS agent runtime",
          source_task_id: "draft",
          assigned_agent_id: "lead",
          workstream: "runtime",
          status: "ready",
          dependencies: [],
          priority: 5,
        }],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agent_steps[0]).toMatchObject({
      agent_id: "lead",
      task_id: "draft",
      work_unit_id: "wu_draft",
      status: "completed",
    });
    expect(saved?.swarm_plan.work_units).toEqual([
      expect.objectContaining({
        id: "wu_draft",
        status: "completed",
        assigned_agent_id: "lead",
        result: expect.objectContaining({
          answer: "Swarm work unit is now backed by TS lifecycle state.",
          evidence: ["agent step linked the unit"],
          risks: ["review gate still follows later"],
          confidence: 0.74,
        }),
        evidence: ["agent step linked the unit"],
        risks: ["review gate still follows later"],
        confidence: 0.74,
        error: null,
        updated_at: fixedNow,
      }),
    ]);
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "swarm",
        name: "Work unit started",
        actor_id: "lead",
        run_id: "run_1",
        round_id: "run_1:round:1",
        status: "in_progress",
        data: expect.objectContaining({
          work_unit_id: "wu_draft",
          agent_id: "lead",
          source_task_id: "draft",
        }),
      }),
      expect.objectContaining({
        kind: "swarm",
        name: "Work unit completed",
        actor_id: "lead",
        status: "completed",
        data: expect.objectContaining({
          work_unit_id: "wu_draft",
          confidence: 0.74,
        }),
      }),
    ]));
  });

  it("replans completed swarm work unit missing work and open questions into follow-up units", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Research completed with follow-up signals.",
        completed_task_ids: ["research"],
        completed_task_results: [{
          task_id: "research",
          answer: "The TS runtime can complete the first swarm lane.",
          evidence: ["AgentRunner produced a structured result."],
          risks: ["Follow-up routing still needs validation."],
          missing_work: ["Check API fallback behavior."],
          open_questions: ["Does native routing need a fallback flag?"],
          confidence: 0.6,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      tasks: {
        research: {
          id: "research",
          title: "Research",
          description: "Research the TS cowork runtime path.",
          assigned_agent_id: "lead",
          dependencies: [],
          status: "ready",
          result: null,
          result_data: {},
          confidence: null,
          error: null,
          priority: 0,
          expected_output: "Research result",
          review_required: false,
          reviewer_agent_ids: [],
          review_status: "",
          fanout_group_id: "",
          merge_task_id: "",
          source_blueprint_id: "",
          source_event_id: "",
          retry_count: 0,
          created_at: fixedNow,
          updated_at: fixedNow,
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "active",
        work_units: [{
          id: "wu_research",
          title: "Research",
          description: "Research the TS cowork runtime path.",
          input: { goal: session!.goal },
          expected_output_schema: {},
          completion_criteria: [],
          assigned_agent_id: "lead",
          dependencies: [],
          status: "ready",
          priority: 0,
          attempts: 0,
          max_attempts: 2,
          tool_allowlist: ["cowork_internal", "read_file"],
          result: {},
          evidence: [],
          risks: [],
          open_questions: [],
          artifacts: [],
          confidence: null,
          error: null,
          source_task_id: "research",
          source_event_id: "swarm_fanout:swarm_1",
          kind: "fanout",
          created_at: fixedNow,
          updated_at: fixedNow,
        }],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    const followUps = ((saved?.swarm_plan.work_units as { kind?: string }[] | undefined) ?? [])
      .filter((unit) => unit.kind === "follow_up");
    expect(followUps).toEqual([
      expect.objectContaining({
        title: "Follow up Research #1",
        description: "Check API fallback behavior.",
        assigned_agent_id: "lead",
        dependencies: ["research"],
        status: "ready",
        source_work_unit_id: "wu_research",
        reason: "missing_work",
        tool_allowlist: ["cowork_internal", "read_file"],
      }),
      expect.objectContaining({
        title: "Follow up Research #2",
        description: "Does native routing need a fallback flag?",
        assigned_agent_id: "lead",
        dependencies: ["research"],
        status: "ready",
        source_work_unit_id: "wu_research",
        reason: "open_question",
        tool_allowlist: ["cowork_internal", "read_file"],
      }),
    ]);
    expect(saved?.events.some((event) => event.type === "swarm.work_unit_added")).toBe(true);
    expect(saved?.trace_spans.some((span) => span.name === "Work unit replanned")).toBe(true);
  });

  it("splits failed broad swarm work units into narrow-scope revision work", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "failed",
        action: "block",
        public_note: "The work unit is too broad to finish in one pass.",
        private_note: "Needs a narrower scope before completion.",
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      swarm_plan: {
        id: "swarm_1",
        status: "active",
        work_units: [{
          id: "wu_draft",
          title: "Draft swarm migration",
          description: "Draft the TS agent runtime with scope too large for one pass.",
          source_task_id: "draft",
          assigned_agent_id: "lead",
          workstream: "runtime",
          status: "ready",
          dependencies: [],
          priority: 5,
          attempts: 2,
          max_attempts: 2,
          tool_allowlist: ["cowork_internal", "read_file"],
        }],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    const revisions = ((saved?.swarm_plan.work_units as { kind?: string; reason?: string }[] | undefined) ?? [])
      .filter((unit) => unit.kind === "revision" && unit.reason === "split_failed_or_broad_unit");
    expect(saved?.tasks.draft).toMatchObject({
      status: "failed",
      error: "The work unit is too broad to finish in one pass.",
    });
    expect(saved?.swarm_plan.work_units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "wu_draft",
        status: "failed",
        error: "The work unit is too broad to finish in one pass.",
      }),
    ]));
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(expect.objectContaining({
      title: "Narrow scope for Draft swarm migration",
      description: expect.stringContaining("Reduce the scope and define a smaller completion path"),
      assigned_agent_id: "lead",
      dependencies: [],
      status: "ready",
      source_work_unit_id: "wu_draft",
      tool_allowlist: ["cowork_internal", "read_file"],
    }));
    expect(revisions[1]).toEqual(expect.objectContaining({
      title: "Complete reduced scope for Draft swarm migration",
      description: expect.stringContaining("Complete the narrowed version of failed work unit wu_draft"),
      assigned_agent_id: "lead",
      dependencies: [expect.any(String)],
      status: "pending",
      source_work_unit_id: "wu_draft",
      tool_allowlist: ["cowork_internal", "read_file"],
    }));
    expect(revisions[1].dependencies).toEqual([revisions[0].source_task_id]);
    expect(saved?.events.some((event) => event.type === "task.failed")).toBe(true);
    expect(saved?.events.some((event) => event.type === "swarm.work_unit_added")).toBe(true);
    expect(saved?.trace_spans.some((span) => span.name === "Work unit replanned")).toBe(true);
  });

  it("processes a completed swarm reducer result and schedules reviewer gate", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Reducer synthesis accepted.",
        private_note: "Captured source-linked reducer output.",
        completed_task_ids: ["reduce"],
        completed_task_results: [{
          task_id: "reduce",
          answer: "Final synthesis with cited source work.",
          findings: ["Research and verification agree."],
          decisions: ["Keep TS reducer gate local to scheduler/runtime."],
          risks: ["Reviewer gate still needs execution."],
          open_questions: [],
          artifact_summary: ["No artifacts."],
          missing_work: [],
          source_work_unit_ids: ["wu_research", "wu_verify"],
          source_artifact_refs: ["artifact://trace"],
          coverage_by_workstream: { runtime: "covered" },
          confidence_by_section: { synthesis: 0.81 },
          confidence: 0.81,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      agents: {
        ...session!.agents,
        reviewer: {
          ...session!.agents.lead,
          id: "reviewer",
          name: "Reviewer",
          role: "Reviewer",
          goal: "Review reducer synthesis",
          status: "idle",
          inbox: [],
          current_task_id: null,
          current_task_title: null,
        },
      },
      tasks: {
        reduce: {
          ...session!.tasks.draft,
          id: "reduce",
          title: "Reduce swarm results",
          description: "Synthesize completed source units.",
          assigned_agent_id: "lead",
          dependencies: ["research", "verify"],
          status: "pending",
          result: null,
          result_data: {},
          confidence: null,
          source_event_id: "swarm_reducer:swarm_1",
        },
        research: {
          ...session!.tasks.draft,
          id: "research",
          title: "Research",
          description: "Collect source behavior",
          assigned_agent_id: "lead",
          status: "completed",
          result: "Research complete.",
          result_data: { answer: "Research complete." },
          confidence: 0.8,
        },
        verify: {
          ...session!.tasks.draft,
          id: "verify",
          title: "Verify",
          description: "Check migration risks",
          assigned_agent_id: "reviewer",
          status: "completed",
          result: "Verification complete.",
          result_data: { answer: "Verification complete." },
          confidence: 0.7,
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "reducing",
        reviewer_agent_id: "reviewer",
        review: { required: true, agent_id: "reviewer" },
        work_units: [
          {
            id: "wu_research",
            title: "Research",
            status: "completed",
            kind: "fanout",
            workstream: "runtime",
            source_task_id: "research",
            result: { answer: "Research complete." },
            artifacts: [{ path_or_url: "artifact://trace", summary: "Trace" }],
            confidence: 0.8,
          },
          {
            id: "wu_verify",
            title: "Verify",
            status: "completed",
            kind: "fanout",
            workstream: "quality",
            source_task_id: "verify",
            result: { answer: "Verification complete." },
            confidence: 0.7,
          },
          {
            id: "wu_reduce",
            title: "Reduce swarm results",
            status: "ready",
            kind: "reducer",
            assigned_agent_id: "lead",
            source_task_id: "reduce",
            source_work_unit_ids: ["wu_research", "wu_verify"],
            dependencies: ["research", "verify"],
          },
        ],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    const reviewerTask = Object.values(saved?.tasks ?? {}).find((task) => task.source_event_id === "swarm_reviewer:swarm_1");
    expect(saved?.final_draft).toBe("Final synthesis with cited source work.");
    expect(saved?.tasks.reduce.result_data).toMatchObject({
      source_work_unit_ids: ["wu_research", "wu_verify"],
      source_artifact_refs: ["artifact://trace"],
      coverage_by_workstream: expect.objectContaining({ runtime: "covered" }),
      confidence_by_section: { synthesis: 0.81 },
    });
    expect(saved?.swarm_plan.status).toBe("reviewing");
    expect(saved?.swarm_plan.work_units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "wu_reduce",
        kind: "reducer",
        status: "completed",
        result: expect.objectContaining({
          answer: "Final synthesis with cited source work.",
          source_work_unit_ids: ["wu_research", "wu_verify"],
          source_artifact_refs: ["artifact://trace"],
          coverage_by_workstream: expect.objectContaining({ runtime: "covered" }),
          confidence_by_section: { synthesis: 0.81 },
        }),
        source_artifact_refs: ["artifact://trace"],
        confidence_by_section: { synthesis: 0.81 },
        confidence: 0.81,
      }),
    ]));
    expect(reviewerTask).toMatchObject({
      title: "Review swarm synthesis",
      assigned_agent_id: "reviewer",
      dependencies: ["reduce"],
      status: "pending",
      source_event_id: "swarm_reviewer:swarm_1",
    });
    expect(saved?.swarm_plan.work_units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "reviewer",
        source_task_id: reviewerTask?.id,
        assigned_agent_id: "reviewer",
        source_work_unit_ids: ["wu_reduce"],
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "synthesis",
        name: "Reducer output accepted",
        actor_id: "lead",
        status: "completed",
        data: expect.objectContaining({
          task_id: "reduce",
          review_required: true,
          source_work_unit_ids: ["wu_research", "wu_verify"],
        }),
      }),
      expect.objectContaining({
        kind: "review",
        name: "Reviewer scheduled",
        actor_id: "scheduler",
        status: "pending",
      }),
    ]));
  });

  it("processes reviewer needs_revision verdict into revision work units", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Reviewer requested targeted revision.",
        private_note: "Reviewer found uncited claims.",
        completed_task_ids: ["review"],
        completed_task_results: [{
          task_id: "review",
          verdict: "needs_revision",
          issues: ["One claim needs a source."],
          coverage_issues: [{ description: "Runtime section is thin." }],
          uncited_claims: ["Claim without source."],
          artifact_issues: [],
          required_fixes: ["Add citations to runtime claim."],
          required_follow_up_units: [{
            title: "Cite runtime claim",
            description: "Add source-backed evidence for the runtime migration claim.",
            source_work_unit_ids: ["wu_reduce"],
            source_artifact_refs: ["artifact://trace"],
          }],
          confidence: 0.52,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      tasks: {
        review: {
          ...session!.tasks.draft,
          id: "review",
          title: "Review swarm synthesis",
          description: "Review reducer synthesis.",
          assigned_agent_id: "lead",
          dependencies: ["reduce"],
          status: "pending",
          result: null,
          result_data: {},
          confidence: null,
          source_event_id: "swarm_reviewer:swarm_1",
        },
        reduce: {
          ...session!.tasks.draft,
          id: "reduce",
          title: "Reduce swarm results",
          description: "Synthesize completed source units.",
          assigned_agent_id: "lead",
          status: "completed",
          result: "Final synthesis.",
          result_data: { answer: "Final synthesis." },
          confidence: 0.81,
          source_event_id: "swarm_reducer:swarm_1",
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "reviewing",
        work_units: [
          {
            id: "wu_reduce",
            title: "Reduce swarm results",
            status: "completed",
            kind: "reducer",
            source_task_id: "reduce",
            result: { answer: "Final synthesis." },
            confidence: 0.81,
          },
          {
            id: "wu_review",
            title: "Review swarm synthesis",
            status: "ready",
            kind: "reviewer",
            assigned_agent_id: "lead",
            source_task_id: "review",
            source_work_unit_ids: ["wu_reduce"],
            dependencies: ["reduce"],
          },
        ],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.review.result_data).toMatchObject({
      review_status: "needs_revision",
      coverage_issues: [{ description: "Runtime section is thin." }],
      uncited_claims: ["Claim without source."],
      artifact_issues: [],
      required_follow_up_units: [{
        title: "Cite runtime claim",
        description: "Add source-backed evidence for the runtime migration claim.",
        source_work_unit_ids: ["wu_reduce"],
        source_artifact_refs: ["artifact://trace"],
      }],
    });
    expect(saved?.swarm_plan.status).toBe("active");
    expect(saved?.swarm_plan.work_units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "revision",
        title: "Cite runtime claim",
        description: "Add source-backed evidence for the runtime migration claim.",
        assigned_agent_id: "lead",
        dependencies: ["review"],
        status: "pending",
        source_work_unit_id: "wu_reduce",
        reason: "reviewer_required_follow_up",
        input: expect.objectContaining({
          reviewer_task_id: "review",
          source_work_unit_ids: ["wu_reduce"],
          source_artifact_refs: ["artifact://trace"],
        }),
      }),
    ]));
    expect(saved?.runtime_state.swarm_evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "uncited_claims",
        status: "warn",
        score: 0.5,
        summary: "1 reducer claim(s) need clearer source citations.",
        issues: [expect.objectContaining({
          code: "review_issue",
          summary: "Claim without source.",
        })],
        recommended_actions: ["add_source_work_unit_ids", "add_source_artifact_refs"],
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "review",
        name: "Reviewer verdict accepted",
        actor_id: "lead",
        status: "completed",
        data: expect.objectContaining({
          task_id: "review",
          verdict: "needs_revision",
          required_fixes: ["Add citations to runtime claim."],
        }),
      }),
    ]));
  });

  it("processes reviewer pass verdict into completed swarm plan", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Reviewer approved synthesis.",
        completed_task_ids: ["review"],
        completed_task_results: [{
          task_id: "review",
          verdict: "pass",
          issues: [],
          coverage_issues: [],
          uncited_claims: [],
          artifact_issues: [],
          required_fixes: [],
          confidence: 0.9,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      workflow_mode: "swarm",
      tasks: {
        review: {
          ...session!.tasks.draft,
          id: "review",
          title: "Review swarm synthesis",
          description: "Review reducer synthesis.",
          assigned_agent_id: "lead",
          dependencies: ["reduce"],
          status: "pending",
          result: null,
          result_data: {},
          confidence: null,
          source_event_id: "swarm_reviewer:swarm_1",
        },
        research: {
          ...session!.tasks.draft,
          id: "research",
          title: "Research",
          status: "completed",
          result: "Research complete.",
          result_data: {
            answer: "Research complete.",
            conflicts: ["Runtime and quality lanes disagree on fallback behavior."],
          },
          confidence: 0.8,
        },
        verify: {
          ...session!.tasks.draft,
          id: "verify",
          title: "Verify",
          status: "completed",
          result: "Verification complete.",
          result_data: { answer: "Verification complete." },
          confidence: 0.7,
        },
        reduce: {
          ...session!.tasks.draft,
          id: "reduce",
          title: "Reduce swarm results",
          assigned_agent_id: "lead",
          status: "completed",
          source_event_id: "swarm_reducer:swarm_1",
          result_data: {
            answer: "Reducer only covered runtime.",
            coverage_by_workstream: { runtime: 1 },
          },
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "reviewing",
        work_units: [
          {
            id: "wu_research",
            title: "Research",
            status: "completed",
            kind: "fanout",
            workstream: "runtime",
            source_task_id: "research",
          },
          {
            id: "wu_verify",
            title: "Verify",
            status: "completed",
            kind: "fanout",
            workstream: "quality",
            source_task_id: "verify",
          },
          {
            id: "wu_reduce",
            title: "Reduce swarm results",
            status: "completed",
            kind: "reducer",
            source_task_id: "reduce",
          },
          {
            id: "wu_review",
            title: "Review swarm synthesis",
            status: "ready",
            kind: "reviewer",
            source_task_id: "review",
            dependencies: ["reduce"],
          },
        ],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.swarm_plan.status).toBe("completed");
    expect(saved?.tasks.review.result_data).toMatchObject({
      review_status: "pass",
      coverage_issues: [],
      uncited_claims: [],
      artifact_issues: [],
      required_follow_up_units: [],
    });
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "review",
        name: "Reviewer verdict accepted",
        status: "completed",
        data: expect.objectContaining({
          task_id: "review",
          verdict: "pass",
        }),
      }),
    ]));
  });

  it("processes reviewer blocked verdict into blocked swarm plan and stop reason", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "blocked",
        action: "block",
        public_note: "Reviewer blocked completion.",
        completed_task_ids: ["review"],
        completed_task_results: [{
          task_id: "review",
          verdict: "blocked",
          issues: ["Synthesis contradicts source evidence."],
          required_fixes: ["Resolve conflicting source claims."],
          coverage_issues: [],
          uncited_claims: [],
          artifact_issues: [],
          confidence: 0.42,
        }],
      }),
      toolCalls: [],
      stopReason: "stop",
    }], [[]]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      goal: "Implement code artifact for Cowork migration",
      workflow_mode: "swarm",
      artifacts: [],
      tasks: {
        review: {
          ...session!.tasks.draft,
          id: "review",
          title: "Review swarm synthesis",
          description: "Review reducer synthesis.",
          assigned_agent_id: "lead",
          dependencies: ["reduce"],
          status: "pending",
          result: null,
          result_data: {},
          confidence: null,
          source_event_id: "swarm_reviewer:swarm_1",
        },
        reduce: {
          ...session!.tasks.draft,
          id: "reduce",
          title: "Reduce swarm results",
          assigned_agent_id: "lead",
          status: "completed",
          source_event_id: "swarm_reducer:swarm_1",
          result_data: {
            answer: "Reducer only covered runtime.",
            coverage_by_workstream: { runtime: 1 },
          },
        },
        research: {
          ...session!.tasks.draft,
          id: "research",
          title: "Research",
          status: "completed",
          result: "Research complete.",
          result_data: {
            answer: "Research complete.",
            conflicts: ["Runtime and quality lanes disagree on fallback behavior."],
          },
          confidence: 0.8,
        },
        verify: {
          ...session!.tasks.draft,
          id: "verify",
          title: "Verify",
          status: "completed",
          result: "Verification complete.",
          result_data: { answer: "Verification complete." },
          confidence: 0.7,
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "reviewing",
        work_units: [
          {
            id: "wu_research",
            title: "Research",
            status: "completed",
            kind: "fanout",
            workstream: "runtime",
            source_task_id: "research",
          },
          {
            id: "wu_verify",
            title: "Verify",
            status: "completed",
            kind: "fanout",
            workstream: "quality",
            source_task_id: "verify",
          },
          {
            id: "wu_reduce",
            title: "Reduce swarm results",
            status: "completed",
            kind: "reducer",
            source_task_id: "reduce",
          },
          {
            id: "wu_review",
            title: "Review swarm synthesis",
            status: "ready",
            kind: "reviewer",
            source_task_id: "review",
            dependencies: ["reduce"],
          },
        ],
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.swarm_plan.status).toBe("blocked");
    expect(saved?.stop_reason).toBe("review_blocked");
    expect(saved?.budget_usage.stop_reason).toBe("review_blocked");
    expect(saved?.tasks.review.result_data).toMatchObject({
      review_status: "blocked",
      required_follow_up_units: [],
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.stop",
        message: "Swarm reviewer blocked completion",
        data: expect.objectContaining({
          stop_reason: "review_blocked",
          task_id: "review",
          issues: ["Synthesis contradicts source evidence."],
          required_fixes: ["Resolve conflicting source claims."],
        }),
      }),
    ]));
    expect(saved?.runtime_state.swarm_evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "evidence_coverage",
        status: "warn",
        score: 0.4,
        summary: "Reducer output does not cite source work-unit ids.",
        recommended_actions: ["add_source_work_unit_ids"],
      }),
      expect.objectContaining({
        kind: "workstream_coverage",
        status: "warn",
        summary: "Reducer output does not cover 1 completed workstream(s).",
        issues: [expect.objectContaining({
          code: "missing_workstream_coverage",
          workstream: "quality",
        })],
        recommended_actions: ["add_coverage_by_workstream", "cite_missing_workstreams"],
      }),
      expect.objectContaining({
        kind: "conflict_detection",
        status: "block",
        summary: "1 unresolved conflict signal(s) detected.",
        issues: [expect.objectContaining({
          task_id: "research",
          kind: "conflicts",
          text: "Runtime and quality lanes disagree on fallback behavior.",
        })],
        blocking_task_ids: ["research"],
        recommended_actions: ["resolve_conflicts"],
      }),
      expect.objectContaining({
        kind: "artifact_validation",
        status: "block",
        summary: "The goal appears to require an artifact, but no artifact is indexed.",
        recommended_actions: ["produce_or_link_required_artifacts"],
      }),
      expect.objectContaining({
        kind: "safety_policy",
        status: "block",
        summary: "Completion is blocked by review_blocked.",
        recommended_actions: ["resolve_safety_or_review_blocker"],
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "review",
        name: "Reviewer verdict accepted",
        status: "blocked",
        data: expect.objectContaining({
          verdict: "blocked",
        }),
      }),
      expect.objectContaining({
        kind: "evaluation",
        name: "Swarm evaluations updated",
        status: "blocked",
        actor_id: "scheduler",
      }),
    ]));
  });

  it("persists public content stream updates without leaking reasoning deltas", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Final public answer.",
        private_note: "Private synthesis details.",
        completed_task_ids: ["draft"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      runtime_state: {
        ...session!.runtime_state,
        origin_channel: "websocket",
        origin_surface: "main_chat",
        origin_chat_id: "chat-1",
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    const streamEvents = saved?.events.filter((event) => event.type === "agent.stream") ?? [];
    expect(provider.options[0]?.onContentDelta).toBeTypeOf("function");
    expect(streamEvents).toEqual([
      expect.objectContaining({
        actor_id: "lead",
        message: "Cowork agent stream update",
        data: expect.objectContaining({
          agent_id: "lead",
          step_id: "step_1",
          phase: "delta",
          status: "running",
          sequence: 1,
          text: "stream content",
          completed: false,
        }),
      }),
      expect.objectContaining({
        actor_id: "lead",
        data: expect.objectContaining({
          phase: "complete",
          status: "completed",
          sequence: 2,
          text: "",
          completed: true,
        }),
      }),
    ]);
    expect(JSON.stringify(streamEvents)).not.toContain("stream reasoning");
    expect(JSON.stringify(streamEvents)).not.toContain("streamed");
    expect(JSON.stringify(streamEvents)).not.toContain("Private synthesis details.");
  });

  it("persists cowork_internal send_message mailbox draft stream updates", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "waiting",
        action: "continue",
        public_note: "Queued a teammate question.",
        completed_task_ids: [],
      }),
      toolCalls: [{
        id: "tool-message",
        name: "cowork_internal",
        argumentsJson: JSON.stringify({
          action: "send_message",
          recipient_ids: ["reviewer"],
          requires_reply: true,
          topic: "Review",
          request_type: "review",
          thread_id: "thread-main",
          content: "Please review the migration draft.",
        }),
      }],
      stopReason: "tool_calls",
    }, {
      content: JSON.stringify({
        status: "waiting",
        action: "continue",
        public_note: "Sent the review request.",
        completed_task_ids: [],
      }),
      toolCalls: [],
      stopReason: "stop",
    }], [[
      {
        index: 0,
        toolCallIndex: 0,
        sequence: 1,
        deltaText: "{\"action\":\"send_message\",\"recipient_ids\":[\"reviewer\"],\"requires_reply\":true,\"topic\":\"Review\",\"request_type\":\"review\",\"thread_id\":\"thread-main\",\"content\":\"Please ",
        toolCallId: "tool-message",
        toolName: "cowork_internal",
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
      {
        index: 0,
        toolCallIndex: 0,
        sequence: 2,
        deltaText: "review the migration draft.\"}",
        toolCallId: "tool-message",
        toolName: "cowork_internal",
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
      {
        index: 0,
        toolCallIndex: 0,
        sequence: 3,
        deltaText: "",
        toolCallId: "tool-message",
        toolName: "cowork_internal",
        phase: "terminal",
        status: "completed",
        completed: true,
      },
    ]]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    await seeded.store.writeSnapshot({
      ...session!,
      runtime_state: {
        ...session!.runtime_state,
        origin_channel: "websocket",
        origin_surface: "main_chat",
        origin_chat_id: "chat-1",
      },
      agents: {
        ...session!.agents,
        reviewer: {
          ...session!.agents.lead,
          id: "reviewer",
          name: "Reviewer",
          role: "Reviewer",
          status: "idle",
          inbox: [],
          current_task_id: null,
          current_task_title: null,
          rounds: 0,
        },
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    const mailboxStreamEvents = saved?.events.filter((event) => event.type === "mailbox.stream") ?? [];
    expect(mailboxStreamEvents).toEqual([
      expect.objectContaining({
        actor_id: "lead",
        message: "Cowork mailbox draft stream update",
        data: expect.objectContaining({
          sender_agent_id: "lead",
          draft_id: "cw_1:lead:tool-message",
          tool_call_id: "tool-message",
          phase: "delta",
          status: "streaming",
          sequence: 1,
          text: "Please ",
          completed: false,
          recipient_ids: ["reviewer"],
          requires_reply: true,
          topic: "Review",
          request_type: "review",
          thread_id: "thread-main",
        }),
      }),
      expect.objectContaining({
        actor_id: "lead",
        data: expect.objectContaining({
          phase: "delta",
          status: "streaming",
          sequence: 2,
          text: "review the migration draft.",
          completed: false,
        }),
      }),
      expect.objectContaining({
        actor_id: "lead",
        data: expect.objectContaining({
          phase: "terminal",
          status: "completed",
          sequence: 3,
          text: "",
          completed: true,
        }),
      }),
    ]);
    expect(JSON.stringify(mailboxStreamEvents)).not.toContain("Queued a teammate question.");
  });

  it("injects cowork_internal so an agent can complete its current task through a tool call", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-1",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "complete_task",
            content: "Completed through the internal cowork tool.",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Internal tool completed the draft.",
          private_note: "Used cowork_internal complete_task.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    const result = await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(result.result).toContain("Lead finished with action complete");
    expect(provider.options[0].tools).toEqual([
      expect.objectContaining({
        name: "cowork_internal",
        description: expect.stringContaining("Coordinate with other cowork agents"),
      }),
    ]);
    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Completed task draft: Draft",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.draft).toMatchObject({
      status: "completed",
      result: "Completed through the internal cowork tool.",
    });
    expect(saved?.events.map((event) => event.type)).toContain("task.completed");
    expect(seeded.tools.has("cowork_internal")).toBe(false);
  });

  it("records cowork tool observations from AgentRunner tool events", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-observation",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "complete_task",
            content: "Observation-backed completion.",
            api_token: "secret",
            nested: { value: "hidden" },
            items: ["a", "b"],
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Observation recorded.",
          private_note: "Tool observation captured.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agent_steps[0].tool_observations).toEqual([
      expect.objectContaining({
        id: "toolobs_1",
        step_id: "step_1",
        tool_name: "cowork_internal",
        calling_agent_id: "lead",
        purpose: "lead called cowork_internal",
        parameter_summary: {
          action: "complete_task",
          content: "Observation-backed completion.",
          api_token: "[redacted]",
          nested: "object[1]",
          items: "list[2]",
        },
        result_summary: "Completed task draft: Draft",
        status: "completed",
        started_at: fixedNow,
        ended_at: fixedNow,
        duration_ms: 0,
        detail_ref: "obsdetail_1",
        redacted: false,
      }),
    ]);
    expect(saved?.observation_details.obsdetail_1).toMatchObject({
      id: "obsdetail_1",
      subject_id: "toolobs_1",
      subject_type: "tool_observation",
      state: "available",
      summary: "Completed task draft: Draft",
      content: "Completed task draft: Draft",
      content_type: "text/plain",
      redacted: false,
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "cowork.observation.available",
        actor_id: "lead",
        data: expect.objectContaining({
          observation_id: "toolobs_1",
          detail_ref: "obsdetail_1",
        }),
      }),
    ]));
    const appendedToolEvents = seeded.appendedEvents.filter((item) => item.event.type === "tool_observation.recorded");
    expect(appendedToolEvents).toEqual([
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          id: "toolobs_1",
          type: "tool_observation.recorded",
          category: "observation",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            tool_observation: expect.objectContaining({
              id: "toolobs_1",
              step_id: "step_1",
              tool_name: "cowork_internal",
              detail_ref: "obsdetail_1",
            }),
          }),
        }),
      }),
    ]);
  });

  it("derives sensitive browser observations from URL-bearing tool events", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-browser-observation",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "complete_task",
            content: "Checked the local preview.",
            url: "http://localhost:3000/preview",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Local preview checked.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agent_steps[0].browser_observations).toEqual([
      expect.objectContaining({
        id: "browserobs_1",
        step_id: "step_1",
        purpose: "lead called cowork_internal",
        resource_ref: "http://localhost:3000/preview",
        result_summary: "Completed task draft: Draft",
        status: "completed",
        accessed_at: fixedNow,
        ended_at: fixedNow,
        duration_ms: 0,
        artifact_refs: ["obsdetail_1"],
        detail_ref: "obsdetail_2",
        sensitive: true,
        redacted: true,
      }),
    ]);
    expect(saved?.observation_details.obsdetail_2).toMatchObject({
      id: "obsdetail_2",
      subject_id: "browserobs_1",
      subject_type: "browser_observation",
      state: "available",
      summary: "Completed task draft: Draft",
      content: "Completed task draft: Draft",
      redacted: true,
      sensitivity: "sensitive",
      artifact_refs: ["obsdetail_1"],
    });
    expect(saved?.sensitive_artifacts.sartifact_1).toMatchObject({
      id: "sartifact_1",
      source_step_id: "step_1",
      source_observation_id: "browserobs_1",
      summary: "Completed task draft: Draft",
      artifact_ref: "obsdetail_2",
      sensitivity: "sensitive",
      permitted_agent_ids: [],
      redacted: true,
      created_at: fixedNow,
    });
    const appendedBrowserEvents = seeded.appendedEvents.filter((item) => item.event.type === "browser_observation.recorded");
    expect(appendedBrowserEvents).toEqual([
      expect.objectContaining({
        sessionId: "cw_1",
        traceId: "trace-agent",
        event: expect.objectContaining({
          schema: "cowork.event_log.v1",
          id: "browserobs_1",
          type: "browser_observation.recorded",
          category: "observation",
          actor_id: "lead",
          created_at: fixedNow,
          payload: expect.objectContaining({
            browser_observation: expect.objectContaining({
              id: "browserobs_1",
              step_id: "step_1",
              resource_ref: "http://localhost:3000/preview",
              detail_ref: "obsdetail_2",
              sensitive: true,
              redacted: true,
            }),
          }),
        }),
      }),
    ]);
  });

  it("parses structured complete_task results from cowork_internal", async () => {
    const structuredResult = {
      answer: "The TS cowork runtime now records structured task output.",
      findings: ["Internal tool calls can carry JSON results."],
      risks: ["Artifact persistence still needs a native writer."],
      artifacts: ["reports/cowork-runtime.md"],
      confidence: 91,
    };
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-structured-complete",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "complete_task",
            content: `Structured result:\n${JSON.stringify(structuredResult)}`,
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Recorded the structured result.",
          private_note: "Used cowork_internal structured complete_task.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.draft).toMatchObject({
      status: "completed",
      result: expect.stringContaining("Structured result:"),
      result_data: structuredResult,
      confidence: 0.91,
    });
    expect(saved?.artifacts).toContain("reports/cowork-runtime.md");
    expect(saved?.shared_memory.findings).toEqual([
      expect.objectContaining({
        text: "Internal tool calls can carry JSON results.",
        source_task_id: "draft",
        author: "lead",
        confidence: 0.91,
      }),
    ]);
    expect(saved?.shared_memory.claims).toEqual([
      expect.objectContaining({
        text: "The TS cowork runtime now records structured task output.",
        source_task_id: "draft",
      }),
    ]);
    expect(saved?.shared_memory.artifacts).toEqual([
      expect.objectContaining({
        text: "reports/cowork-runtime.md",
      }),
    ]);
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "task",
        name: "Task completed",
        actor_id: "lead",
        status: "completed",
        data: expect.objectContaining({
          task_id: "draft",
          confidence: 0.91,
          result_data: structuredResult,
        }),
      }),
    ]));
  });

  it("lets an agent send a cowork message and add a follow-up task through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "tool-message",
            name: "cowork_internal",
            argumentsJson: JSON.stringify({
              action: "send_message",
              recipient_ids: ["user"],
              content: "I found a follow-up item for the migration.",
            }),
          },
          {
            id: "tool-task",
            name: "cowork_internal",
            argumentsJson: JSON.stringify({
              action: "add_task",
              title: "Document internal cowork tool",
              description: "Document the new TypeScript cowork_internal actions.",
              assigned_agent_id: "lead",
              dependencies: ["draft"],
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "I queued the follow-up work.",
          private_note: "Used cowork_internal send_message and add_task.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: expect.stringMatching(/^Sent message msg_/),
    }));
    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: expect.stringMatching(/^Added task task_/),
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(Object.values(saved?.messages ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sender_id: "lead",
        recipient_ids: ["user"],
        content: "I found a follow-up item for the migration.",
      }),
    ]));
    expect(Object.values(saved?.mailbox ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sender_id: "lead",
        recipient_ids: ["user"],
        content: "I found a follow-up item for the migration.",
        status: "delivered",
      }),
    ]));
    expect(Object.values(saved?.tasks ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Document internal cowork tool",
        assigned_agent_id: "lead",
        dependencies: ["draft"],
        status: "pending",
      }),
    ]));
    expect(saved?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["mailbox.queued", "mailbox.delivered", "task.created"]));
  });

  it("lets an agent create a discussion thread through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-thread",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "create_thread",
            topic: "Review lane",
            recipient_ids: ["user", "reviewer", "missing"],
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Created a review discussion thread.",
          private_note: "Used cowork_internal create_thread.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.reviewer = {
      ...session.agents.lead,
      id: "reviewer",
      name: "Reviewer",
      role: "Reviewer",
      status: "idle",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
      rounds: 0,
    };
    await seeded.store.writeSnapshot(session, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Created thread thread_2: Review lane",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.threads.thread_2).toMatchObject({
      id: "thread_2",
      topic: "Review lane",
      participant_ids: ["lead", "user", "reviewer"],
      message_ids: [],
      status: "open",
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "thread.created",
        data: expect.objectContaining({
          thread_id: "thread_2",
          source: "cowork_internal",
        }),
      }),
    ]));
  });

  it("lets an agent retire another agent through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-retire",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "retire_agent",
            assigned_agent_id: "reviewer",
            content: "Review lane no longer needed.",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Retired the unused reviewer lane.",
          private_note: "Used cowork_internal retire_agent.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.reviewer = {
      ...session.agents.lead,
      id: "reviewer",
      name: "Reviewer",
      role: "Reviewer",
      status: "working",
      lifecycle_status: "active",
      inbox: ["msg_1"],
      current_task_id: "review",
      current_task_title: "Review",
      delegated_task_id: "dtask_1",
      rounds: 2,
    };
    session.tasks.review = {
      ...session.tasks.draft,
      id: "review",
      title: "Review",
      description: "Review the draft",
      assigned_agent_id: "reviewer",
      status: "in_progress",
      result: null,
      result_data: {},
      dependencies: [],
    };
    session.delegated_tasks.dtask_1 = {
      id: "dtask_1",
      status: "requested",
      error: "",
      updated_at: "2026-06-12T09:00:00.000Z",
    };
    await seeded.store.writeSnapshot(session, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Agent 'Reviewer' retired.",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.reviewer).toMatchObject({
      status: "retired",
      lifecycle_status: "retired",
      current_task_id: null,
      current_task_title: null,
    });
    expect(saved?.delegated_tasks.dtask_1).toMatchObject({
      status: "retired",
      retired_at: fixedNow,
      updated_at: fixedNow,
      error: "Review lane no longer needed.",
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.retired",
        actor_id: "reviewer",
        data: expect.objectContaining({
          agent_id: "reviewer",
          reason: "Review lane no longer needed.",
          delegated_task_id: "dtask_1",
          source: "cowork_internal",
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "agent",
        name: "Agent retired",
        actor_id: "reviewer",
        status: "completed",
      }),
    ]));
  });

  it("lets an agent spawn a temporary specialist through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-spawn",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "spawn_agent",
            role: "Researcher",
            goal: "Research TS cowork stream hooks",
            responsibilities: ["Find the Python hook flow", "Report risks"],
            tools: ["read_file", "cowork_internal"],
            subscriptions: ["research"],
            team_id: "migration",
            work_unit_id: "wu_1",
            content: "Need a bounded research lane.",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Spawned a research specialist.",
          private_note: "Used cowork_internal spawn_agent.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Spawned agent researcher: Researcher",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.researcher).toMatchObject({
      id: "researcher",
      name: "Researcher",
      role: "Researcher",
      goal: "Research TS cowork stream hooks",
      responsibilities: ["Find the Python hook flow", "Report risks"],
      tools: ["read_file", "cowork_internal"],
      subscriptions: ["research"],
      parent_agent_id: "lead",
      team_id: "migration",
      lifetime: "temporary",
      lifecycle_status: "active",
      spawn_reason: "Need a bounded research lane.",
      delegated_task_id: "dtask_1",
      delegated_brief_id: "dbrief_1",
      isolated_context_id: "ictx_1",
      sub_agent_scope: "parent",
    });
    expect(saved?.delegated_tasks.dtask_1).toMatchObject({
      id: "dtask_1",
      parent_agent_id: "lead",
      brief_id: "dbrief_1",
      status: "active",
      sub_agent_id: "researcher",
      work_unit_id: "wu_1",
    });
    expect(saved?.delegated_briefs.dbrief_1).toMatchObject({
      id: "dbrief_1",
      parent_agent_id: "lead",
      task_goal: "Research TS cowork stream hooks",
      allowed_tools: ["read_file", "cowork_internal"],
    });
    expect(saved?.isolated_sub_agent_contexts.ictx_1).toMatchObject({
      id: "ictx_1",
      delegated_task_id: "dtask_1",
      sub_agent_id: "researcher",
      parent_agent_id: "lead",
      brief_id: "dbrief_1",
    });
    expect(saved?.budget_usage.spawned_agents).toBe(1);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.spawned",
        actor_id: "lead",
        data: expect.objectContaining({
          agent_id: "researcher",
          parent_agent_id: "lead",
          team_id: "migration",
          work_unit_id: "wu_1",
          delegated_task_id: "dtask_1",
          delegated_brief_id: "dbrief_1",
          isolated_context_id: "ictx_1",
          source: "cowork_internal",
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "agent",
        name: "Agent spawned",
        actor_id: "lead",
      }),
    ]));
  });

  it("denies cowork_internal spawn_agent when the spawned-agent budget is exhausted", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-spawn",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "spawn_agent",
            role: "Researcher",
            goal: "Research TS cowork stream hooks",
            tools: ["read_file", "cowork_internal"],
            content: "Need another bounded research lane.",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Spawn was denied by guardrails.",
          private_note: "cowork_internal spawn_agent hit budget limits.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    await seeded.store.writeSnapshot({
      ...session,
      budget_limits: {
        ...session.budget_limits,
        max_spawned_agents: 1,
      },
      budget_usage: {
        ...session.budget_usage,
        spawned_agents: 1,
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: expect.stringContaining("Error: spawned-agent budget exhausted"),
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.researcher).toBeUndefined();
    expect(saved?.budget_usage).toMatchObject({
      spawned_agents: 1,
      stop_reason: "spawn_budget_exhausted",
    });
    expect(saved?.stop_reason).toBe("spawn_budget_exhausted");
    expect(Object.values(saved?.delegation_guardrails ?? {})).toEqual([
      expect.objectContaining({
        parent_agent_id: "lead",
        max_spawned_agents: 1,
        denied_reasons: ["spawned_agent_budget_exhausted"],
      }),
    ]);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.budget_exhausted",
        actor_id: "scheduler",
        data: expect.objectContaining({
          stop_reason: "spawn_budget_exhausted",
          parent_agent_id: "lead",
          max_spawned_agents: 1,
        }),
      }),
      expect.objectContaining({
        type: "delegation.denied",
        actor_id: "lead",
        data: expect.objectContaining({
          denied_reasons: ["spawned_agent_budget_exhausted"],
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Stop reason",
        status: "blocked",
        data: expect.objectContaining({
          stop_reason: "spawn_budget_exhausted",
        }),
      }),
    ]));
  });

  it("lets an agent spawn a temporary subteam through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-subteam",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "spawn_subteam",
            team_id: "analysis-lane",
            content: "Split research and verification work.",
            agents: [
              {
                role: "Researcher",
                goal: "Collect migration evidence",
                responsibilities: ["Find source behavior"],
                tools: ["read_file", "cowork_internal"],
                subscriptions: ["analysis"],
                work_unit_id: "wu_research",
              },
              {
                role: "Verifier",
                goal: "Check migration risks",
                responsibilities: ["Review evidence"],
                tools: ["cowork_internal"],
                subscriptions: ["analysis"],
                work_unit_id: "wu_verify",
              },
            ],
            tasks: [
              {
                title: "Collect evidence",
                description: "Find the Python behavior.",
                assigned_agent_id: "researcher",
              },
              {
                title: "Verify evidence",
                description: "Check the migration risk.",
                owner: "verifier",
                dependencies: ["draft"],
              },
            ],
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Spawned an analysis subteam.",
          private_note: "Used cowork_internal spawn_subteam.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Spawned subteam analysis-lane with 2 agent(s).",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.researcher).toMatchObject({
      id: "researcher",
      role: "Researcher",
      team_id: "analysis-lane",
      parent_agent_id: "lead",
      source_event_id: "evt_src_1",
      delegated_task_id: "dtask_1",
    });
    expect(saved?.agents.verifier).toMatchObject({
      id: "verifier",
      role: "Verifier",
      team_id: "analysis-lane",
      parent_agent_id: "lead",
      source_event_id: "evt_src_1",
      delegated_task_id: "dtask_2",
    });
    expect(saved?.tasks.task_1).toMatchObject({
      title: "Collect evidence",
      assigned_agent_id: "researcher",
      fanout_group_id: "analysis-lane",
      source_event_id: "evt_src_1",
    });
    expect(saved?.tasks.task_2).toMatchObject({
      title: "Verify evidence",
      assigned_agent_id: "verifier",
      dependencies: ["draft"],
      fanout_group_id: "analysis-lane",
      source_event_id: "evt_src_1",
    });
    expect(Object.values(saved?.messages ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sender_id: "lead",
        recipient_ids: ["researcher", "verifier"],
        content: "Split research and verification work.",
      }),
    ]));
    expect(saved?.agents.researcher.inbox).toEqual(expect.arrayContaining([expect.stringMatching(/^msg_/)]));
    expect(saved?.agents.verifier.inbox).toEqual(expect.arrayContaining([expect.stringMatching(/^msg_/)]));
    expect(saved?.budget_usage.spawned_agents).toBe(2);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "subteam.spawned",
        actor_id: "lead",
        data: expect.objectContaining({
          team_id: "analysis-lane",
          agent_ids: ["researcher", "verifier"],
          task_ids: ["task_1", "task_2"],
          reason: "Split research and verification work.",
          source_event_id: "evt_src_1",
        }),
      }),
    ]));
  });

  it("denies cowork_internal spawn_subteam when the spawned-agent budget is exhausted", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-subteam",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "spawn_subteam",
            team_id: "analysis-lane",
            content: "Split research and verification work.",
            agents: [
              { role: "Researcher", goal: "Collect migration evidence" },
              { role: "Verifier", goal: "Check migration risks" },
            ],
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Subteam spawn was denied by guardrails.",
          private_note: "cowork_internal spawn_subteam hit budget limits.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    await seeded.store.writeSnapshot({
      ...session,
      budget_limits: {
        ...session.budget_limits,
        max_spawned_agents: 1,
      },
      budget_usage: {
        ...session.budget_usage,
        spawned_agents: 1,
      },
    }, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: expect.stringContaining("Error: spawned-agent budget exhausted"),
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.agents.researcher).toBeUndefined();
    expect(saved?.agents.verifier).toBeUndefined();
    expect(saved?.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "subteam.spawned" }),
    ]));
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "delegation.denied",
        actor_id: "lead",
        data: expect.objectContaining({
          denied_reasons: ["spawned_agent_budget_exhausted"],
        }),
      }),
    ]));
  });

  it("lets an agent assign a task and update its status through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "tool-assign",
            name: "cowork_internal",
            argumentsJson: JSON.stringify({
              action: "assign_task",
              task_id: "review",
              assigned_agent_id: "reviewer",
            }),
          },
          {
            id: "tool-status",
            name: "cowork_internal",
            argumentsJson: JSON.stringify({
              action: "update_status",
              status: "waiting",
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Review task handed off.",
          private_note: "Assigned review and set status to waiting.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.reviewer = {
      ...session.agents.lead,
      id: "reviewer",
      name: "Reviewer",
      role: "Reviewer",
      status: "idle",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
      rounds: 0,
    };
    session.tasks.review = {
      ...session.tasks.draft,
      id: "review",
      title: "Review",
      description: "Review the TS cowork internal tool migration",
      assigned_agent_id: null,
      status: "pending",
      result: null,
      result_data: {},
      dependencies: [],
    };
    await seeded.store.writeSnapshot(session, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Task 'Review' assigned to Reviewer.",
    }));
    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Status updated to waiting",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.review).toMatchObject({
      assigned_agent_id: "reviewer",
      status: "pending",
    });
    expect(saved?.agents.reviewer).toMatchObject({
      status: "waiting",
      inbox: [],
    });
    expect(saved?.agents.lead.status).toBe("waiting");
    expect(saved?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.assigned", "agent.status"]));
    expect(saved?.trace_spans.map((span) => span.name)).toEqual(expect.arrayContaining(["Task assigned"]));
  });

  it("lets an agent claim the first ready shared task through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-claim",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "claim_task",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Claimed shared work.",
          private_note: "Used cowork_internal claim_task.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.tasks.draft.status = "completed";
    session.tasks.alpha = {
      ...session.tasks.draft,
      id: "alpha",
      title: "Alpha",
      description: "First shared ready task",
      assigned_agent_id: null,
      status: "pending",
      result: null,
      result_data: {},
      dependencies: [],
      created_at: "2026-06-12T09:00:00.000Z",
    };
    session.tasks.beta = {
      ...session.tasks.alpha,
      id: "beta",
      title: "Beta",
      description: "Second shared ready task",
      created_at: "2026-06-12T08:00:00.000Z",
    };
    await seeded.store.writeSnapshot(session, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: "Claimed task alpha: Alpha",
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.alpha).toMatchObject({
      assigned_agent_id: "lead",
      status: "in_progress",
    });
    expect(saved?.agents.lead).toMatchObject({
      status: "waiting",
      current_task_id: null,
      current_task_title: null,
    });
    expect(saved?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.claimed"]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "task", name: "Task claimed", actor_id: "lead" }),
    ]));
  });

  it("records a conflict when an agent tries to claim another agent's task through cowork_internal", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "tool-claim",
          name: "cowork_internal",
          argumentsJson: JSON.stringify({
            action: "claim_task",
            task_id: "review",
          }),
        }],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          public_note: "Could not claim owned work.",
          private_note: "Claim conflict recorded.",
          completed_task_ids: [],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const seeded = await seedRuntime(provider);
    const session = await seeded.store.readSnapshot("cw_1", "setup");
    if (!session) {
      throw new Error("missing seeded session");
    }
    session.agents.reviewer = {
      ...session.agents.lead,
      id: "reviewer",
      name: "Reviewer",
      role: "Reviewer",
      status: "waiting",
      inbox: [],
      current_task_id: null,
      current_task_title: null,
      rounds: 0,
    };
    session.tasks.review = {
      ...session.tasks.draft,
      id: "review",
      title: "Review",
      description: "Review owned by reviewer",
      assigned_agent_id: "reviewer",
      status: "pending",
      result: null,
      result_data: {},
      dependencies: [],
    };
    await seeded.store.writeSnapshot(session, "setup");

    await seeded.runtime.runAgent({
      traceId: "trace-agent",
      sessionId: "cw_1",
      agentId: "lead",
      runId: "run_1",
      roundId: "run_1:round:1",
      parentSpanId: "span_parent",
    });

    expect(provider.messages[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "cowork_internal",
      content: expect.stringContaining("Error: task 'review' is already claimed by 'reviewer'"),
    }));
    const saved = await seeded.store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.review.assigned_agent_id).toBe("reviewer");
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task.claim_conflict",
        actor_id: "lead",
        data: expect.objectContaining({
          task_id: "review",
          requested_agent_id: "lead",
          owner_agent_id: "reviewer",
          winner_agent_id: "lead",
        }),
      }),
    ]));
  });
});
