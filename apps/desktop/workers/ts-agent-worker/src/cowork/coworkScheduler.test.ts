import { describe, expect, it } from "vitest";

import { AgentRunner } from "../agent/agentRunner";
import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { ToolRegistry } from "../tools/toolRegistry";
import { CoworkAgentRuntime } from "./coworkAgentRuntime";
import { CoworkScheduler } from "./coworkScheduler";
import { CoworkService, createMemoryCoworkStore, type CoworkIdGenerator, type CoworkServiceStore } from "./coworkService";
import type { CoworkSession } from "./coworkTypes";

const fixedNow = "2026-06-12T09:00:00.000Z";

function deterministicIds(): CoworkIdGenerator {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

async function seedSession(
  store: CoworkServiceStore = createMemoryCoworkStore(),
): Promise<{ store: CoworkServiceStore; session: CoworkSession; scheduler: CoworkScheduler }> {
  const idGenerator = deterministicIds();
  const service = new CoworkService({
    store,
    now: () => fixedNow,
    idGenerator,
  });
  const session = await service.createSession({
    traceId: "seed",
    goal: "Coordinate TS cowork scheduler migration",
    title: "Scheduler session",
    workflowMode: "team",
    agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
    tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
  });
  return {
    store,
    session,
    scheduler: new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
    }),
  };
}

class QueueProvider implements ModelProvider {
  readonly messages: AgentMessage[][] = [];
  readonly options: ModelRequestOptions[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("CoworkScheduler", () => {
  it("records a paused stop reason without starting a run", async () => {
    const seeded = await seedSession();
    await seeded.store.writeSnapshot({ ...seeded.session, status: "paused" }, "seed");

    const result = await seeded.scheduler.runSession({ sessionId: seeded.session.id, traceId: "trace-run" });

    expect(result.result).toBe("Session cw_1 is paused.");
    const saved = await seeded.store.readSnapshot(seeded.session.id, "assert");
    expect(saved?.stop_reason).toBe("paused");
    expect(saved?.budget_usage.stop_reason).toBe("paused");
    expect(saved?.run_metrics).toHaveLength(0);
    expect(saved?.events.at(-1)).toMatchObject({
      type: "scheduler.stop",
      message: "Session cw_1 is paused.",
      data: { stop_reason: "paused" },
    });
  });

  it("records a completed stop reason without starting a run", async () => {
    const seeded = await seedSession();
    await seeded.store.writeSnapshot({ ...seeded.session, status: "completed" }, "seed");

    const result = await seeded.scheduler.runSession({ sessionId: seeded.session.id, traceId: "trace-run" });

    expect(result.result).toBe("Session cw_1 is already completed.");
    const saved = await seeded.store.readSnapshot(seeded.session.id, "assert");
    expect(saved?.stop_reason).toBe("completed");
    expect(saved?.budget_usage.stop_reason).toBe("completed");
    expect(saved?.run_metrics).toHaveLength(0);
  });

  it("persists an idle scheduler run when no agent runtime is configured", async () => {
    const seeded = await seedSession();

    const result = await seeded.scheduler.runSession({
      sessionId: seeded.session.id,
      traceId: "trace-run",
      maxRounds: 2,
      maxAgents: 2,
    });

    expect(result.result).toContain("Round 1: no ready agents.");
    expect(result.runId).toBe("run_1");
    const saved = await seeded.store.readSnapshot(seeded.session.id, "assert");
    expect(saved?.stop_reason).toBe("idle");
    expect(saved?.budget_usage).toMatchObject({ rounds: 0, agent_calls: 0, stop_reason: "idle" });
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 0,
      agent_calls: 0,
      stop_reason: "idle",
    })]);
    expect(saved?.scheduler_decisions).toEqual([expect.objectContaining({
      id: "decision_1",
      run_id: "run_1",
      round_id: "run_1:round:1",
      selected_agent_ids: [],
      reason: "No TS cowork agent runtime is configured",
    })]);
    expect(saved?.trace_spans.map((span) => span.name)).toContain("Cowork run");
    expect(saved?.trace_spans.map((span) => span.name)).toContain("Stop reason");
  });

  it("stops before selecting agents when stopOnBlocker sees unresolved blockers", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        completed_task_ids: ["draft"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [
        { id: "lead", name: "Lead", role: "Coordinator" },
        { id: "worker", name: "Worker", role: "Worker" },
      ],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
    });
    session.mailbox.env_blocker = {
      id: "env_blocker",
      sender_id: "worker",
      recipient_ids: ["lead"],
      content: "Need product input before continuing.",
      status: "delivered",
      requires_reply: true,
      blocking_task_id: "draft",
      priority: 80,
      created_at: fixedNow,
      updated_at: fixedNow,
    };
    await store.writeSnapshot(session, "setup");
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 2,
      stopOnBlocker: true,
    });

    expect(result.result).toContain("Round 1: stopped on blocker.");
    expect(provider.messages).toHaveLength(0);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.stop_reason).toBe("blocker");
    expect(saved?.budget_usage).toMatchObject({ rounds: 0, agent_calls: 0, stop_reason: "blocker" });
    expect(saved?.scheduler_decisions).toHaveLength(0);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.stop",
        data: expect.objectContaining({
          stop_reason: "blocker",
          round_id: "run_1:round:1",
          decision: expect.objectContaining({
            blocked: [expect.objectContaining({
              id: "env_blocker",
              sender_id: "worker",
              blocking_task_id: "draft",
            })],
          }),
        }),
      }),
    ]));
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 0,
      agent_calls: 0,
      stop_reason: "blocker",
    })]);
  });

  it("stops before selecting agents when the session agent-call budget is exhausted", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        completed_task_ids: ["draft"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
      budgets: {
        max_agent_calls_per_run: 10,
        max_agent_calls_total: 1,
      },
    });
    await store.writeSnapshot({
      ...session,
      budget_usage: {
        ...session.budget_usage,
        agent_calls: 1,
      },
    }, "setup");
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 2,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: agent call budget exhausted.");
    expect(provider.messages).toHaveLength(0);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.stop_reason).toBe("agent_call_budget_exhausted");
    expect(saved?.budget_usage).toMatchObject({
      rounds: 0,
      agent_calls: 1,
      stop_reason: "agent_call_budget_exhausted",
    });
    expect(saved?.scheduler_decisions).toHaveLength(0);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.agent_budget_exhausted",
        data: expect.objectContaining({
          stop_reason: "agent_call_budget_exhausted",
          round_id: "run_1:round:1",
          budget: expect.objectContaining({
            remaining: expect.objectContaining({ max_agent_calls_total: 0, parallel_width: 3 }),
          }),
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Stop reason",
        status: "blocked",
        data: expect.objectContaining({
          stop_reason: "agent_call_budget_exhausted",
        }),
      }),
    ]));
  });

  it("emits Python-compatible budget-exhausted events for non-agent budget stops", async () => {
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        completed_task_ids: ["draft"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
      budgets: {
        max_tokens: 100,
      },
    });
    await store.writeSnapshot({
      ...session,
      budget_usage: {
        ...session.budget_usage,
        tokens_total: 100,
      },
    }, "setup");
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 2,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: token budget exhausted.");
    expect(provider.messages).toHaveLength(0);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.stop_reason).toBe("token_budget_exhausted");
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.budget_exhausted",
        data: expect.objectContaining({
          stop_reason: "token_budget_exhausted",
          round_id: "run_1:round:1",
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Stop reason",
        status: "blocked",
        data: expect.objectContaining({
          stop_reason: "token_budget_exhausted",
        }),
      }),
    ]));
  });

  it("stops with convergence after consecutive rounds without tracked progress", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
    });
    await store.writeSnapshot({
      ...session,
      no_progress_rounds: 1,
    }, "setup");
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "waiting",
        action: "continue",
        private_note: "Still thinking; no tracked progress.",
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 3,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    expect(result.result).toContain("Session stopped after 2 no-progress rounds.");
    expect(provider.messages).toHaveLength(1);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.no_progress_rounds).toBe(2);
    expect(saved?.stop_reason).toBe("convergence");
    expect(saved?.budget_usage).toMatchObject({ rounds: 1, agent_calls: 1, stop_reason: "convergence" });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.no_progress",
        data: expect.objectContaining({
          no_progress_rounds: 2,
          before: expect.any(Array),
          after: expect.any(Array),
        }),
      }),
      expect.objectContaining({
        type: "scheduler.stop",
        data: expect.objectContaining({
          stop_reason: "convergence",
          no_progress_rounds: 2,
        }),
      }),
    ]));
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 1,
      agent_calls: 1,
      stop_reason: "convergence",
    })]);
  });

  it("runs the lead once for synthesis after teammate replies are ready", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [
        { id: "worker", name: "Worker", role: "Researcher" },
        { id: "lead", name: "Lead", role: "Coordinator" },
      ],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "worker" }],
    });
    session.messages.reply_msg = {
      id: "reply_msg",
      thread_id: "thread_1",
      sender_id: "worker",
      recipient_ids: ["lead"],
      content: "Worker result ready for synthesis.",
      visibility: "direct",
      kind: "message",
      created_at: fixedNow,
      read_by: ["worker"],
      envelope_id: "reply_env",
    };
    session.threads.thread_1 = {
      id: "thread_1",
      topic: "General discussion",
      participant_ids: ["lead", "worker"],
      message_ids: ["reply_msg"],
      status: "open",
      created_at: fixedNow,
      updated_at: fixedNow,
      last_message_at: fixedNow,
    };
    session.agents.lead.inbox = ["reply_msg"];
    session.agents.lead.status = "waiting";
    session.mailbox.lead_request = {
      id: "lead_request",
      sender_id: "lead",
      recipient_ids: ["worker"],
      content: "Please produce the worker result.",
      status: "replied",
      requires_reply: true,
      correlation_id: "corr-1",
      created_at: fixedNow,
      updated_at: fixedNow,
    };
    session.mailbox.reply_env = {
      id: "reply_env",
      sender_id: "worker",
      recipient_ids: ["lead"],
      content: "Worker result ready for synthesis.",
      status: "delivered",
      requires_reply: false,
      message_id: "reply_msg",
      reply_to_envelope_id: "lead_request",
      correlation_id: "corr-1",
      created_at: fixedNow,
      updated_at: fixedNow,
    };
    await store.writeSnapshot(session, "setup");
    const provider = new QueueProvider([
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Worker kept state unchanged.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "respond_user",
          public_note: "Synthesized team answer.",
          private_note: "Synthesized teammate replies.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running worker");
    expect(result.result).toContain("Round 2: running lead for synthesis");
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1]?.at(1)?.content).toContain("Worker result ready for synthesis.");
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.budget_usage).toMatchObject({ rounds: 1, agent_calls: 2, stop_reason: "max_rounds" });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.lead_synthesis",
        data: expect.objectContaining({ agent_id: "lead" }),
      }),
    ]));
    expect(Object.values(saved?.messages ?? {}).some((message) => message.content === "Synthesized team answer.")).toBe(true);
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 1,
      agent_calls: 2,
      stop_reason: "max_rounds",
    })]);
  });

  it("stops as ready_to_finish after a round when completion is ready and no agents remain active like Python", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Summarize completed coordination",
      title: "Ready summary",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [],
    });
    session.completion_decision = {
      next_action: "summarize",
      ready_to_finish: true,
      reason: "Known task results appear sufficient.",
    };
    await store.writeSnapshot(session, "setup");
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        private_note: "Ready to summarize.",
        completed_task_ids: ["1"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    expect(result.result).toContain("Session is ready for summary.");
    expect(provider.messages).toHaveLength(1);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.stop_reason).toBe("ready_to_finish");
    expect(saved?.budget_usage).toMatchObject({ rounds: 1, agent_calls: 1, stop_reason: "ready_to_finish" });
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 1,
      agent_calls: 1,
      stop_reason: "ready_to_finish",
    })]);
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.stop",
        data: expect.objectContaining({
          stop_reason: "ready_to_finish",
          round_id: "run_1:round:1",
        }),
      }),
    ]));
  });

  it("limits repeated self-activation after three consecutive agent runs like Python", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Avoid self-activation loops",
      title: "Self activation",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [],
    });
    await store.writeSnapshot(session, "setup");
    const provider = new QueueProvider([
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Seeded follow-up 1.",
          new_task_suggestions: [{ title: "Follow-up 1", assigned_agent_id: "lead" }],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Seeded follow-up 2.",
          new_task_suggestions: [{ title: "Follow-up 2", assigned_agent_id: "lead" }],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Seeded follow-up 3.",
          new_task_suggestions: [{ title: "Follow-up 3", assigned_agent_id: "lead" }],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "This fourth self-activation should not run.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 5,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 4: no ready agents.");
    expect(provider.messages).toHaveLength(3);
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.stop_reason).toBe("idle");
    expect(saved?.budget_usage).toMatchObject({ rounds: 3, agent_calls: 3, stop_reason: "idle" });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "scheduler.self_activation_limited",
        actor_id: "lead",
        message: "Lead was skipped after repeated self-activation",
        data: expect.objectContaining({
          agent_id: "lead",
          limit: 3,
        }),
      }),
    ]));
  });

  it("runs a ready agent through CoworkAgentRuntime when configured", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" }],
    });
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "done",
        action: "complete",
        public_note: "Scheduler agent round complete.",
        private_note: "Completed from scheduler.",
        completed_task_ids: ["draft"],
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: "cw_1",
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    const saved = await store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.draft.status).toBe("completed");
    expect(saved?.stop_reason).toBe("ready_to_finish");
    expect(saved?.budget_usage).toMatchObject({ rounds: 1, agent_calls: 1, stop_reason: "ready_to_finish" });
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      status: "stopped",
      rounds: 1,
      agent_calls: 1,
      stop_reason: "ready_to_finish",
    })]);
    expect(saved?.scheduler_decisions).toEqual([expect.objectContaining({
      selected_agent_ids: ["lead"],
      reason: expect.stringContaining("Selected lead"),
    })]);
  });

  it("limits generator-verifier scheduler rounds to one agent like Python", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Generate and verify a TS migration slice",
      title: "Generator verifier session",
      workflowMode: "generator_verifier",
      agents: [
        { id: "generator", name: "Generator", role: "Generate the implementation" },
        { id: "verifier", name: "Verifier", role: "Verify the implementation" },
      ],
      tasks: [
        {
          id: "generate",
          title: "Generate slice",
          description: "Implement the migration slice",
          assigned_agent_id: "generator",
        },
        {
          id: "verify",
          title: "Verify slice",
          description: "Check the migration slice",
          assigned_agent_id: "verifier",
        },
      ],
    });
    const provider = new QueueProvider([
      {
        content: JSON.stringify({
          status: "working",
          action: "continue",
          private_note: "Generator started the implementation.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "working",
          action: "continue",
          private_note: "Verifier should wait for the next scheduler round.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 2,
      maxAgentCalls: 4,
    });

    const saved = await store.readSnapshot(session.id, "assert");
    expect(provider.messages).toHaveLength(1);
    expect(saved?.scheduler_decisions).toEqual([expect.objectContaining({
      selected_agent_ids: ["generator"],
    })]);
    expect(saved?.budget_usage).toMatchObject({ rounds: 1, agent_calls: 1 });
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      rounds: 1,
      agent_calls: 1,
    })]);
  });

  it("reports when an agent round completes the session like Python", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Complete the migration summary",
      title: "Completion session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft final summary", assigned_agent_id: "lead" }],
    });
    const agentRuntime = {
      async runAgent(request: { sessionId: string; traceId?: string }) {
        const current = await store.readSnapshot(request.sessionId, request.traceId ?? "");
        if (!current) {
          throw new Error("session not found");
        }
        await store.writeSnapshot({
          ...current,
          status: "completed",
          tasks: {
            ...current.tasks,
            draft: {
              ...current.tasks.draft,
              status: "completed",
              result: "Final migration summary is complete.",
            },
          },
        }, request.traceId ?? "");
      },
    } as unknown as CoworkAgentRuntime;
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    expect(result.result).toContain("Session completed.");
    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.status).toBe("completed");
    expect(saved?.stop_reason).toBe("completed");
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      status: "completed",
      rounds: 1,
      agent_calls: 1,
      messages: Object.keys(saved?.messages ?? {}).length,
      tasks_created: 1,
      tasks_completed: 1,
      artifacts_created: 0,
      stop_reason: "completed",
    })]);
  });

  it("continues across scheduler rounds when completed dependencies unlock new ready tasks", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    await service.createSession({
      traceId: "seed",
      goal: "Coordinate TS cowork scheduler migration",
      title: "Scheduler session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
      tasks: [
        { id: "draft", title: "Draft", description: "Draft scheduler slice", assigned_agent_id: "lead" },
        {
          id: "review",
          title: "Review",
          description: "Review the completed scheduler slice",
          assigned_agent_id: "lead",
          dependencies: ["draft"],
        },
      ],
    });
    const provider = new QueueProvider([
      {
        content: JSON.stringify({
          status: "idle",
          action: "complete",
          public_note: "Draft complete.",
          private_note: "Completed first round.",
          completed_task_ids: ["draft"],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Review complete.",
          private_note: "Completed second round.",
          completed_task_ids: ["review"],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    let nowTick = 0;
    const advancingNow = () => new Date(Date.parse(fixedNow) + nowTick++ * 1000).toISOString();
    const scheduler = new CoworkScheduler({
      store,
      now: advancingNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: "cw_1",
      traceId: "trace-run",
      maxRounds: 2,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    expect(result.result).toContain("Round 2: running lead");
    expect(provider.messages).toHaveLength(2);
    const saved = await store.readSnapshot("cw_1", "assert");
    expect(saved?.tasks.draft.status).toBe("completed");
    expect(saved?.tasks.review.status).toBe("completed");
    expect(saved?.stop_reason).toBe("ready_to_finish");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "summarize",
      ready_to_finish: true,
      reason: "All known tasks are complete or skipped.",
    });
    expect(saved?.budget_usage).toMatchObject({ rounds: 2, agent_calls: 2, stop_reason: "ready_to_finish" });
    expect(Number(saved?.budget_usage.wall_time_seconds)).toBeGreaterThan(0);
    expect(saved?.run_metrics).toEqual([expect.objectContaining({
      id: "run_1",
      status: "stopped",
      rounds: 2,
      agent_calls: 2,
      stop_reason: "ready_to_finish",
    })]);
    expect(saved?.scheduler_decisions).toEqual([
      expect.objectContaining({
        run_id: "run_1",
        round_id: "run_1:round:1",
        selected_agent_ids: ["lead"],
      }),
      expect.objectContaining({
        run_id: "run_1",
        round_id: "run_1:round:2",
        selected_agent_ids: ["lead"],
      }),
    ]);
  });

  it("fairly selects swarm ready work units across workstreams", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Coordinate parallel swarm workstreams",
      title: "Swarm scheduler session",
      workflowMode: "swarm",
      agents: [
        { id: "alpha1", name: "Alpha 1", role: "Researcher" },
        { id: "alpha2", name: "Alpha 2", role: "Researcher" },
        { id: "beta1", name: "Beta 1", role: "Verifier" },
      ],
      tasks: [
        { id: "alpha_task_1", title: "Alpha one", description: "First alpha work", assigned_agent_id: "alpha1" },
        { id: "alpha_task_2", title: "Alpha two", description: "Second alpha work", assigned_agent_id: "alpha2" },
        { id: "beta_task_1", title: "Beta one", description: "First beta work", assigned_agent_id: "beta1" },
      ],
      budgets: { parallel_width: 2 },
    });
    await store.writeSnapshot({
      ...session,
      swarm_plan: {
        id: "swarm_1",
        status: "active",
        work_units: [
          {
            id: "wu_alpha_1",
            title: "Alpha one",
            status: "ready",
            assigned_agent_id: "alpha1",
            source_task_id: "alpha_task_1",
            workstream_id: "alpha",
            priority: 10,
            created_at: "2026-06-12T08:00:00.000Z",
          },
          {
            id: "wu_alpha_2",
            title: "Alpha two",
            status: "ready",
            assigned_agent_id: "alpha2",
            source_task_id: "alpha_task_2",
            workstream_id: "alpha",
            priority: 9,
            created_at: "2026-06-12T08:01:00.000Z",
          },
          {
            id: "wu_beta_1",
            title: "Beta one",
            status: "ready",
            assigned_agent_id: "beta1",
            source_task_id: "beta_task_1",
            workstream_id: "beta",
            priority: 8,
            created_at: "2026-06-12T08:02:00.000Z",
          },
        ],
      },
    }, "setup");
    const provider = new QueueProvider([
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Alpha started.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      {
        content: JSON.stringify({
          status: "waiting",
          action: "continue",
          private_note: "Beta started.",
        }),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 2,
    });

    const saved = await store.readSnapshot(session.id, "assert");
    expect(saved?.scheduler_decisions[0]).toMatchObject({
      selected_agent_ids: ["alpha1", "beta1"],
      reason: expect.stringContaining("swarm"),
    });
    expect(saved?.scheduler_decisions[0].candidate_scores).toMatchObject({
      alpha1: expect.objectContaining({ work_unit_id: "wu_alpha_1", workstream: "alpha", rank: 1 }),
      beta1: expect.objectContaining({ work_unit_id: "wu_beta_1", workstream: "beta", rank: 2 }),
    });
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[0]?.at(1)?.content).toContain("Alpha one");
    expect(provider.messages[1]?.at(1)?.content).toContain("Beta one");
  });

  it("schedules a swarm reducer gate after base work units finish", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "seed",
      goal: "Synthesize completed swarm migration work",
      title: "Swarm reducer session",
      workflowMode: "swarm",
      agents: [
        { id: "lead", name: "Lead", role: "Coordinator" },
        { id: "researcher", name: "Researcher", role: "Researcher" },
      ],
      tasks: [
        { id: "research", title: "Research", description: "Collect source behavior", assigned_agent_id: "researcher" },
        { id: "verify", title: "Verify", description: "Check migration risks", assigned_agent_id: "lead" },
      ],
      budgets: { parallel_width: 1 },
    });
    await store.writeSnapshot({
      ...session,
      tasks: {
        ...session.tasks,
        research: {
          ...session.tasks.research,
          status: "completed",
          result: "Python reducer behavior documented.",
          result_data: { answer: "Python reducer behavior documented.", evidence: ["service.py"] },
          confidence: 0.8,
        },
        verify: {
          ...session.tasks.verify,
          status: "completed",
          result: "No blocking TS risks.",
          result_data: { answer: "No blocking TS risks.", risks: [] },
          confidence: 0.7,
        },
      },
      swarm_plan: {
        id: "swarm_1",
        status: "active",
        reducer_agent_id: "lead",
        work_units: [
          {
            id: "wu_research",
            title: "Research",
            status: "completed",
            assigned_agent_id: "researcher",
            source_task_id: "research",
            kind: "fanout",
            result: { answer: "Python reducer behavior documented." },
            evidence: ["service.py"],
            risks: [],
            confidence: 0.8,
          },
          {
            id: "wu_verify",
            title: "Verify",
            status: "completed",
            assigned_agent_id: "lead",
            source_task_id: "verify",
            kind: "fanout",
            result: { answer: "No blocking TS risks." },
            evidence: [],
            risks: [],
            confidence: 0.7,
          },
        ],
      },
    }, "setup");
    const provider = new QueueProvider([{
      content: JSON.stringify({
        status: "working",
        action: "continue",
        private_note: "Reducer started.",
      }),
      toolCalls: [],
      stopReason: "stop",
    }]);
    const agentRuntime = new CoworkAgentRuntime({
      store,
      runner: new AgentRunner({ provider, tools: new ToolRegistry() }),
      model: "test-model",
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
      agentRuntime,
    });

    const result = await scheduler.runSession({
      sessionId: session.id,
      traceId: "trace-run",
      maxRounds: 1,
      maxAgents: 1,
    });

    expect(result.result).toContain("Round 1: running lead");
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]?.at(1)?.content).toContain("Reduce swarm results");
    const saved = await store.readSnapshot(session.id, "assert");
    const reducerTask = Object.values(saved?.tasks ?? {}).find((task) => task.source_event_id === "swarm_reducer:swarm_1");
    expect(reducerTask).toMatchObject({
      title: "Reduce swarm results",
      assigned_agent_id: "lead",
      dependencies: ["research", "verify"],
      status: "in_progress",
    });
    const reducerUnit = (saved?.swarm_plan.work_units as unknown[]).find((unit) => (unit as { source_task_id?: string }).source_task_id === reducerTask?.id);
    expect(reducerUnit).toMatchObject({
      kind: "reducer",
      assigned_agent_id: "lead",
      source_work_unit_ids: ["wu_research", "wu_verify"],
      status: "in_progress",
    });
    expect(saved?.swarm_plan).toMatchObject({
      status: "reducing",
      updated_at: fixedNow,
    });
    expect(saved?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "swarm.reducer_scheduled",
        actor_id: "scheduler",
        data: expect.objectContaining({
          task_id: reducerTask?.id,
          source_work_unit_ids: ["wu_research", "wu_verify"],
        }),
      }),
    ]));
    expect(saved?.trace_spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "swarm",
        name: "Reducer scheduled",
        actor_id: "scheduler",
        status: "pending",
      }),
    ]));
  });
});
