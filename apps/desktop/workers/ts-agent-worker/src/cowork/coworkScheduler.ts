import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { selectReadyCoworkAgentCandidates, type CoworkAgentRuntime } from "./coworkAgentRuntime.ts";
import { normalizeCoworkSession } from "./coworkSerde.ts";
import type { CoworkAgent, CoworkEvent, CoworkSession, CoworkTask } from "./coworkTypes.ts";
import type { CoworkIdGenerator, CoworkServiceStore } from "./coworkService.ts";

const DEFAULT_BUDGET_USAGE: JsonObject = {
  rounds: 0,
  agent_calls: 0,
  spawned_agents: 0,
  tool_calls: 0,
  tokens_prompt: 0,
  tokens_completion: 0,
  tokens_total: 0,
  cost: 0,
  wall_time_seconds: 0,
  stop_reason: "",
};

const DEFAULT_BUDGET_LIMITS: JsonObject = {
  max_rounds_per_run: 20,
  parallel_width: 3,
  max_agent_calls_per_run: 30,
  max_agent_calls_total: null,
  max_spawned_agents: 0,
  max_work_units: 30,
  max_retry_attempts: 2,
  max_tool_calls: null,
  max_tokens: null,
  max_cost: null,
  max_wall_time_seconds: null,
};

const CONVERGENCE_IDLE_ROUNDS = 2;
const MAX_AGENT_SELF_ACTIVATIONS = 3;

export type CoworkSchedulerOptions = {
  store: CoworkServiceStore;
  now?: () => string;
  idGenerator?: CoworkIdGenerator;
  agentRuntime?: CoworkAgentRuntime;
};

export type CoworkRunSessionRequest = {
  sessionId: string;
  traceId?: string;
  maxRounds?: number;
  maxAgents?: number;
  maxAgentCalls?: number;
  runUntilIdle?: boolean;
  stopOnBlocker?: boolean;
};

export type CoworkRunSessionResult = {
  session: CoworkSession | null;
  result: string;
  runId?: string;
};

export class CoworkScheduler {
  private readonly store: CoworkServiceStore;
  private readonly now: () => string;
  private readonly idGenerator: CoworkIdGenerator;
  private readonly agentRuntime?: CoworkAgentRuntime;

  constructor(options: CoworkSchedulerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
    this.agentRuntime = options.agentRuntime;
  }

  async runSession(request: CoworkRunSessionRequest): Promise<CoworkRunSessionResult> {
    const traceId = request.traceId ?? "";
    const session = await this.store.readSnapshot(request.sessionId, traceId);
    if (!session) {
      return {
        session: null,
        result: `Error: cowork session '${request.sessionId}' not found`,
      };
    }
    if (session.status === "paused") {
      const message = `Session ${session.id} is paused.`;
      const saved = await this.recordStopReason(session, "paused", message, traceId);
      return { session: saved, result: message };
    }
    if (session.status === "completed") {
      const message = `Session ${session.id} is already completed.`;
      const saved = await this.recordStopReason(session, "completed", message, traceId);
      return { session: saved, result: message };
    }

    const runId = this.idGenerator("run");
    const budget = budgetState(session);
    const roundLimit = runRoundLimit(request.maxRounds, budget, request.runUntilIdle === true);
    const agentLimit = runAgentLimit(request.maxAgents, budget);
    const maxAgentCalls = runAgentCallLimit(request.maxAgentCalls, budget);
    const runStartedAt = this.now();
    const runSpanId = this.idGenerator("span");
    session.trace_spans = [
      ...session.trace_spans,
      {
        id: runSpanId,
        session_id: session.id,
        kind: "scheduler",
        name: "Cowork run",
        run_id: runId,
        actor_id: "scheduler",
        status: "running",
        started_at: runStartedAt,
        ended_at: null,
        input_ref: `max_rounds=${roundLimit}, max_agents=${agentLimit}, max_agent_calls=${maxAgentCalls}`,
        output_ref: "",
        summary: `Run Cowork session with up to ${roundLimit} rounds, ${agentLimit} agents per round, and ${maxAgentCalls} agent calls`,
        data: {
          run_until_idle: request.runUntilIdle === true,
          stop_on_blocker: request.stopOnBlocker === true,
          budget,
        },
      },
    ];
    session.run_metrics = [
      ...session.run_metrics,
      {
        id: runId,
        started_at: runStartedAt,
        ended_at: null,
        status: "running",
        rounds: 0,
        agent_calls: 0,
        tool_calls: 0,
        messages: 0,
        tasks: 0,
        artifacts: 0,
        stop_reason: "",
      },
    ];
    await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);

    if (!this.agentRuntime) {
      const roundId = `${runId}:round:1`;
      session.scheduler_decisions = [
        ...session.scheduler_decisions,
        {
          id: this.idGenerator("decision"),
          run_id: runId,
          round_id: roundId,
          selected_agent_ids: [],
          candidate_scores: {},
          reason: "No TS cowork agent runtime is configured",
          budget_remaining: {
            agent_calls: maxAgentCalls,
            rounds: roundLimit,
            effective_agent_limit: agentLimit,
            session: budget.remaining,
          },
          created_at: this.now(),
        },
      ];
      const message = "Cowork scheduler stopped because no agents are ready";
      this.applyStopReason(session, "idle", message, {
        runId,
        roundId,
        parentId: runSpanId,
        data: { scheduler_runtime: "deferred_agent_runtime" },
      });
      this.finishRun(session, runId, runSpanId, "stopped", 0, 0);
      const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
      return {
        session: saved,
        result: [
          "Round 1: no ready agents.",
          "",
          `## ${saved.title} (${saved.id})`,
          `Status: ${saved.status}`,
          `Stop reason: ${saved.stop_reason}`,
        ].join("\n"),
        runId,
      };
    }

    let working = session;
    const lines: string[] = [];
    let completedRounds = 0;
    let agentCalls = 0;
    let synthesisRan = false;
    const consecutiveRuns = new Map<string, number>();
    for (let roundIndex = 0; roundIndex < roundLimit; roundIndex += 1) {
      const roundNumber = roundIndex + 1;
      const roundId = `${runId}:round:${roundNumber}`;
      const latest = await this.store.readSnapshot(working.id, traceId);
      if (latest) {
        working = latest;
      }
      const beforeSignature = progressSignature(working);
      if (request.stopOnBlocker === true) {
        const decision = assessBlockers(working);
        if (decision.blocked.length > 0 || decision.review_blockers.length > 0 || decision.fanout_blockers.length > 0) {
          lines.push(`Round ${roundNumber}: stopped on blocker.`);
          this.applyStopReason(working, "blocker", "Cowork scheduler stopped because blockers are visible", {
            runId,
            roundId,
            parentId: runSpanId,
            data: { decision },
          });
          break;
        }
      }
      const exhausted = budgetExhaustionReason(working, {
        runAgentCalls: agentCalls,
        runAgentCallLimit: maxAgentCalls,
        elapsedWallTimeSeconds: elapsedSeconds(runStartedAt, this.now()),
      });
      if (exhausted) {
        lines.push(`Round ${roundNumber}: ${exhausted.replaceAll("_", " ")}.`);
        this.applyStopReason(working, exhausted, "Cowork scheduler stopped at a configured budget limit", {
          runId,
          roundId,
          parentId: runSpanId,
          data: { budget: budgetState(working), agent_calls: agentCalls },
        });
        break;
      }
      const remainingCalls = maxAgentCalls - agentCalls;
      if (remainingCalls <= 0) {
        lines.push(`Round ${roundNumber}: agent call budget exhausted.`);
        this.applyStopReason(working, "agent_call_budget_exhausted", "Cowork scheduler stopped at the agent call budget", {
          runId,
          roundId,
          parentId: runSpanId,
          data: { max_agent_calls: maxAgentCalls, agent_calls: agentCalls },
        });
        break;
      }

      ensureSwarmReducerGate(working, this.now, this.idGenerator);
      const effectiveAgentLimit = Math.min(agentLimit, remainingCalls);
      const selection = selectReadyCoworkAgentCandidates(working, effectiveAgentLimit);
      const active = this.filterSelfActivatedAgents(working, selection.agents, consecutiveRuns);
      if (active.length === 0) {
        lines.push(`Round ${roundNumber}: no ready agents.`);
        this.applyStopReason(working, "idle", "Cowork scheduler stopped because no agents are ready", {
          runId,
          roundId,
          parentId: runSpanId,
        });
        break;
      }

      const selectedIds = active.map((agent) => agent.id);
      lines.push(`Round ${roundNumber}: running ${selectedIds.join(", ")}`);
      const currentBudget = budgetState(working);
      working.scheduler_decisions = [
        ...working.scheduler_decisions,
        {
          id: this.idGenerator("decision"),
          run_id: runId,
          round_id: roundId,
          selected_agent_ids: selectedIds,
          candidate_scores: selection.candidateScores,
          reason: `Selected ${selectedIds.join(", ")} using ${selection.reasonProfile}`,
          budget_remaining: {
            agent_calls: Math.max(0, maxAgentCalls - agentCalls - selectedIds.length),
            rounds: Math.max(0, roundLimit - roundNumber),
            effective_agent_limit: effectiveAgentLimit,
            session: currentBudget.remaining,
          },
          created_at: this.now(),
        },
      ];
      const roundSpanId = this.idGenerator("span");
      working.trace_spans = [
        ...working.trace_spans,
        {
          id: roundSpanId,
          session_id: working.id,
          kind: "scheduler",
          name: `Scheduler round ${roundNumber}`,
          run_id: runId,
          round_id: roundId,
          parent_id: runSpanId,
          actor_id: "scheduler",
          status: "running",
          started_at: this.now(),
          ended_at: null,
          input_ref: selectedIds.join(", "),
          output_ref: "",
          summary: `Running ${selectedIds.join(", ")}`,
          data: { agent_ids: selectedIds, profile: working.workflow_mode, candidate_scores: selection.candidateScores },
        },
      ];
      working.events = [
        ...working.events,
        this.event("scheduler.round", `Cowork scheduler running round ${roundNumber} with ${selectedIds.join(", ")}`, {
          actorId: "scheduler",
          data: { round: roundNumber, agent_ids: selectedIds },
        }),
      ];
      await this.store.writeSnapshot(normalizeCoworkSession(working), traceId);
      for (const agent of active) {
        await this.agentRuntime.runAgent({
          traceId,
          sessionId: working.id,
          agentId: agent.id,
          runId,
          roundId,
          parentSpanId: roundSpanId,
        });
      }
      working = await this.store.readSnapshot(working.id, traceId) ?? working;
      working.trace_spans = working.trace_spans.map((span) => {
        if (stringValue(span.id) !== roundSpanId) {
          return span;
        }
        return {
          ...span,
          ended_at: this.now(),
          status: "completed",
          output_ref: `Ran ${selectedIds.length} agent(s)`,
          summary: `Round ${roundNumber} finished`,
        };
      });
      completedRounds += 1;
      agentCalls += selectedIds.length;
      this.recordRoundProgress(working, beforeSignature);
      updateConsecutiveRuns(consecutiveRuns, selectedIds);
      if (convergenceReached(working)) {
        lines.push(`Session stopped after ${working.no_progress_rounds} no-progress rounds.`);
        this.applyStopReason(working, "convergence", "Cowork scheduler stopped because recent rounds produced no new tracked progress", {
          runId,
          roundId,
          parentId: runSpanId,
          data: { no_progress_rounds: working.no_progress_rounds },
        });
        break;
      }
      if (!synthesisRan && agentCalls < maxAgentCalls && leadReadyToSynthesizeReplies(working)) {
        working = await this.runLeadSynthesis(working, {
          traceId,
          runId,
          roundId: `${runId}:round:${roundNumber + 1}:synthesis`,
          parentSpanId: runSpanId,
          roundNumber: roundNumber + 1,
          lines,
        });
        agentCalls += 1;
        synthesisRan = true;
      }
      if (working.status === "completed") {
        this.applyStopReason(working, "completed", "Cowork scheduler stopped because the session completed", {
          runId,
          roundId,
          parentId: runSpanId,
        });
        break;
      }
      if (readyToFinishWithoutActiveAgents(working)) {
        lines.push("Session is ready for summary.");
        this.applyStopReason(working, "ready_to_finish", "Cowork scheduler stopped because the session is ready for summary", {
          runId,
          roundId,
          parentId: runSpanId,
        });
        break;
      }
      if (!request.runUntilIdle && completedRounds >= roundLimit) {
        this.applyStopReason(working, "max_rounds", "Cowork scheduler stopped at the requested round limit", {
          runId,
          roundId,
          parentId: runSpanId,
        });
        break;
      }
    }

    if (!cleanString(working.stop_reason) && !cleanString(working.budget_usage.stop_reason)) {
      this.applyStopReason(working, "max_rounds", "Cowork scheduler stopped at the run budget", {
        runId,
        parentId: runSpanId,
      });
    }
    this.finishRun(working, runId, runSpanId, working.status === "completed" ? "completed" : "stopped", completedRounds, agentCalls);
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(working), traceId);
    return {
      session: saved,
      result: [
        ...lines,
        "",
        `## ${saved.title} (${saved.id})`,
        `Status: ${saved.status}`,
        `Stop reason: ${saved.stop_reason}`,
      ].join("\n"),
      runId,
    };
  }

  private async recordStopReason(
    session: CoworkSession,
    reason: string,
    message: string,
    traceId: string,
  ): Promise<CoworkSession> {
    this.applyStopReason(session, reason, message);
    return this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
  }

  private recordRoundProgress(session: CoworkSession, before: number[]): void {
    const after = progressSignature(session);
    const progressed = !sameSignature(before, after);
    session.no_progress_rounds = progressed ? 0 : (numberValue(session.no_progress_rounds) ?? 0) + 1;
    if (!progressed) {
      session.events = [
        ...session.events,
        this.event("scheduler.no_progress", `Cowork round produced no new tracked progress (${session.no_progress_rounds}/${CONVERGENCE_IDLE_ROUNDS})`, {
          actorId: "scheduler",
          data: { before, after, no_progress_rounds: session.no_progress_rounds },
        }),
      ];
    }
  }

  private filterSelfActivatedAgents(session: CoworkSession, active: CoworkAgent[], consecutiveRuns: Map<string, number>): CoworkAgent[] {
    const filtered: CoworkAgent[] = [];
    for (const agent of active) {
      if ((consecutiveRuns.get(agent.id) ?? 0) < MAX_AGENT_SELF_ACTIVATIONS) {
        filtered.push(agent);
        continue;
      }
      session.events = [
        ...session.events,
        this.event("scheduler.self_activation_limited", `${agent.name} was skipped after repeated self-activation`, {
          actorId: agent.id,
          data: { agent_id: agent.id, limit: MAX_AGENT_SELF_ACTIVATIONS },
        }),
      ];
    }
    return filtered;
  }

  private async runLeadSynthesis(
    session: CoworkSession,
    request: { traceId: string; runId: string; roundId: string; parentSpanId: string; roundNumber: number; lines: string[] },
  ): Promise<CoworkSession> {
    const leadId = leadAgentId(session);
    const lead = session.agents[leadId];
    if (!lead || !this.agentRuntime) {
      return session;
    }
    request.lines.push(`Round ${request.roundNumber}: running ${lead.id} for synthesis`);
    session.events = [
      ...session.events,
      this.event("scheduler.lead_synthesis", `Cowork scheduler running ${lead.name} for final synthesis`, {
        actorId: "scheduler",
        data: { agent_id: lead.id },
      }),
    ];
    await this.store.writeSnapshot(normalizeCoworkSession(session), request.traceId);
    await this.agentRuntime.runAgent({
      traceId: request.traceId,
      sessionId: session.id,
      agentId: lead.id,
      runId: request.runId,
      roundId: request.roundId,
      parentSpanId: request.parentSpanId,
    });
    return await this.store.readSnapshot(session.id, request.traceId) ?? session;
  }

  private applyStopReason(
    session: CoworkSession,
    reason: string,
    message: string,
    options: { runId?: string; roundId?: string; parentId?: string; data?: JsonObject } = {},
  ): void {
    const timestamp = this.now();
    session.stop_reason = reason;
    session.budget_usage = {
      ...DEFAULT_BUDGET_USAGE,
      ...jsonSafeObject(session.budget_usage),
      stop_reason: reason,
    };
    const eventType = stopReasonEventType(reason);
    const traceStatus = stopReasonTraceStatus(reason);
    session.events = [
      ...session.events,
      this.event(eventType, message, {
        actorId: "scheduler",
        data: {
          stop_reason: reason,
          ...(options.runId ? { run_id: options.runId } : {}),
          ...(options.roundId ? { round_id: options.roundId } : {}),
          ...jsonSafeObject(options.data),
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("scheduler", "Stop reason", {
        sessionId: session.id,
        actorId: "scheduler",
        status: traceStatus,
        runId: options.runId,
        roundId: options.roundId,
        parentId: options.parentId,
        summary: message,
        data: {
          stop_reason: reason,
          ...jsonSafeObject(options.data),
        },
      }),
    ];
    session.updated_at = timestamp;
  }

  private finishRun(session: CoworkSession, runId: string, runSpanId: string, status: string, rounds: number, agentCalls: number): void {
    const stopReason = cleanString(session.stop_reason) || cleanString(session.budget_usage.stop_reason);
    session.run_metrics = session.run_metrics.map((metric) => {
      if (stringValue(metric.id) !== runId) {
        return metric;
      }
      return {
        ...metric,
        ended_at: this.now(),
        status,
        rounds,
        agent_calls: agentCalls,
        stop_reason: stopReason,
      };
    });
    session.trace_spans = session.trace_spans.map((span) => {
      if (stringValue(span.id) !== runSpanId) {
        return span;
      }
      return {
        ...span,
        ended_at: this.now(),
        status,
        output_ref: `rounds=${rounds}, agent_calls=${agentCalls}`,
        summary: `Cowork run ${status}`,
      };
    });
    session.budget_usage = {
      ...DEFAULT_BUDGET_USAGE,
      ...jsonSafeObject(session.budget_usage),
      rounds: (numberValue(session.budget_usage.rounds) ?? 0) + rounds,
      agent_calls: (numberValue(session.budget_usage.agent_calls) ?? 0) + agentCalls,
      stop_reason: stopReason,
    };
    session.updated_at = this.now();
  }

  private event(type: string, message: string, options: { actorId?: string; data?: JsonObject } = {}): CoworkEvent {
    return {
      id: this.idGenerator("evt"),
      type,
      message,
      ...(options.actorId !== undefined ? { actor_id: options.actorId } : {}),
      ...(options.data ? { data: options.data } : {}),
      created_at: this.now(),
    };
  }

  private traceSpan(
    kind: string,
    name: string,
    options: {
      sessionId: string;
      actorId?: string;
      status?: string;
      runId?: string;
      roundId?: string;
      parentId?: string;
      summary?: string;
      data?: JsonObject;
    },
  ): JsonObject {
    return {
      id: this.idGenerator("span"),
      session_id: options.sessionId,
      kind,
      name,
      actor_id: options.actorId ?? null,
      status: options.status ?? "completed",
      run_id: options.runId ?? "",
      round_id: options.roundId ?? "",
      parent_id: options.parentId ?? null,
      started_at: this.now(),
      ended_at: this.now(),
      input_ref: "",
      summary: options.summary ?? "",
      data: options.data ?? {},
    };
  }
}

function runRoundLimit(value: unknown, budget: JsonObject, runUntilIdle: boolean): number {
  const defaultLimit = Math.max(1, numberValue(jsonSafeObject(budget.limits).max_rounds_per_run) ?? 20);
  if (runUntilIdle) {
    return defaultLimit;
  }
  const requested = Math.max(1, numberValue(value) ?? defaultLimit);
  return Math.min(requested, defaultLimit);
}

function runAgentLimit(value: unknown, budget: JsonObject): number {
  const parallelWidth = Math.max(1, numberValue(jsonSafeObject(budget.limits).parallel_width) ?? 3);
  const requested = Math.max(1, numberValue(value) ?? parallelWidth);
  return Math.min(requested, parallelWidth);
}

function runAgentCallLimit(value: unknown, budget: JsonObject): number {
  return Math.max(1, numberValue(value) ?? numberValue(jsonSafeObject(budget.limits).max_agent_calls_per_run) ?? 30);
}

function budgetState(session: CoworkSession): JsonObject {
  const limits = {
    ...DEFAULT_BUDGET_LIMITS,
    ...jsonSafeObject(session.budget_limits),
  };
  const usage = {
    ...DEFAULT_BUDGET_USAGE,
    ...jsonSafeObject(session.budget_usage),
  };
  const stopReason = cleanString(session.stop_reason) || cleanString(usage.stop_reason);
  usage.stop_reason = stopReason;
  return {
    limits,
    usage,
    remaining: budgetRemaining(limits, usage),
    stop_reason: stopReason,
  };
}

function budgetRemaining(limits: JsonObject, usage: JsonObject): JsonObject {
  const pairs: Record<string, string> = {
    max_rounds_per_run: "rounds",
    max_agent_calls_per_run: "agent_calls",
    max_agent_calls_total: "agent_calls",
    max_spawned_agents: "spawned_agents",
    max_tool_calls: "tool_calls",
    max_tokens: "tokens_total",
    max_cost: "cost",
    max_wall_time_seconds: "wall_time_seconds",
  };
  const remaining: JsonObject = {};
  for (const [limitKey, usageKey] of Object.entries(pairs)) {
    const limit = numberValue(limits[limitKey]);
    remaining[limitKey] = limit === null ? null : Math.max(0, limit - (numberValue(usage[usageKey]) ?? 0));
  }

  remaining.parallel_width = limits.parallel_width;
  return remaining;
}

function progressSignature(session: CoworkSession): number[] {
  const memoryCount = Object.values(jsonSafeObject(session.shared_memory))
    .reduce<number>((count, entries) => count + (Array.isArray(entries) ? entries.length : 0), 0);
  const completedCount = Object.values(session.tasks)
    .filter((task) => task.status === "completed")
    .length;
  const activeRecords = Object.values(session.mailbox)
    .filter((record) => !["replied", "expired"].includes(cleanString(record.status)))
    .length;
  return [
    Object.keys(session.messages).length,
    Object.keys(session.tasks).length,
    completedCount,
    session.artifacts.length,
    memoryCount,
    activeRecords,
  ];
}

function sameSignature(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function convergenceReached(session: CoworkSession): boolean {
  return (numberValue(session.no_progress_rounds) ?? 0) >= CONVERGENCE_IDLE_ROUNDS;
}

function leadReadyToSynthesizeReplies(session: CoworkSession): boolean {
  const leadId = leadAgentId(session);
  const lead = session.agents[leadId];
  if (!lead || lead.inbox.length === 0) {
    return false;
  }
  const records = Object.values(session.mailbox);
  const pendingLeadRequests = records.some((record) => stringValue(record.sender_id) === leadId
    && record.requires_reply === true
    && ["delivered", "read"].includes(cleanString(record.status)));
  if (pendingLeadRequests) {
    return false;
  }
  const leadInboxIds = new Set(lead.inbox);
  const leadRequestIds = new Set(records
    .filter((record) => stringValue(record.sender_id) === leadId && record.requires_reply === true)
    .map((record) => stringValue(record.id))
    .filter(Boolean));
  const leadRequestCorrelations = new Set(records
    .filter((record) => stringValue(record.sender_id) === leadId && record.requires_reply === true && stringValue(record.correlation_id))
    .map((record) => stringValue(record.correlation_id)));
  return records.some((record) => leadInboxIds.has(stringValue(record.message_id))
    && !["user", leadId].includes(stringValue(record.sender_id))
    && (
      (stringValue(record.reply_to_envelope_id) && leadRequestIds.has(stringValue(record.reply_to_envelope_id)))
      || (stringValue(record.correlation_id) && leadRequestCorrelations.has(stringValue(record.correlation_id)))
    ));
}

function readyToFinishWithoutActiveAgents(session: CoworkSession): boolean {
  if (jsonSafeObject(session.completion_decision).ready_to_finish !== true) {
    return false;
  }
  return selectReadyCoworkAgentCandidates(session, 1).agents.length === 0;
}

function updateConsecutiveRuns(consecutiveRuns: Map<string, number>, selectedIds: string[]): void {
  const selected = new Set(selectedIds);
  for (const agentId of selected) {
    consecutiveRuns.set(agentId, (consecutiveRuns.get(agentId) ?? 0) + 1);
  }
  for (const agentId of [...consecutiveRuns.keys()]) {
    if (!selected.has(agentId)) {
      consecutiveRuns.set(agentId, 0);
    }
  }
}

function leadAgentId(session: CoworkSession): string {
  for (const candidate of ["coordinator", "lead", "team_lead", "team-lead"]) {
    if (session.agents[candidate]) {
      return candidate;
    }
  }
  return Object.keys(session.agents)[0] ?? "";
}

function ensureSwarmReducerGate(session: CoworkSession, now: () => string, idGenerator: CoworkIdGenerator): CoworkTask | null {
  if (!swarmReducerShouldRun(session)) {
    return null;
  }
  const existing = existingSwarmGateTask(session, "reducer");
  if (existing) {
    return existing;
  }
  const plan = jsonSafeObject(session.swarm_plan);
  const reducerAgentId = session.agents[cleanString(plan.reducer_agent_id)]
    ? cleanString(plan.reducer_agent_id)
    : leadAgentId(session);
  const sourceUnits = swarmWorkUnits(session)
    .filter((unit) => !["reducer", "reviewer"].includes(cleanString(unit.kind)))
    .filter((unit) => ["completed", "failed", "skipped"].includes(cleanString(unit.status)));
  const dependencyIds = sourceUnits
    .map((unit) => cleanString(unit.source_task_id))
    .filter((taskId) => taskId && ["completed", "skipped"].includes(session.tasks[taskId]?.status ?? ""));
  const taskId = idGenerator("task");
  const timestamp = now();
  const summaries = sourceUnits.slice(-12).map((unit) => {
    const result = jsonSafeObject(unit.result);
    const answer = cleanString(result.answer) || cleanString(unit.error) || cleanString(unit.skip_reason);
    return `- ${cleanString(unit.id)}: ${cleanString(unit.title)} [${cleanString(unit.status)}]${answer ? ` - ${answer.slice(0, 240)}` : ""}`;
  });
  const task: CoworkTask = {
    id: taskId,
    title: "Reduce swarm results",
    description: [
      "Synthesize the swarm work units into a structured final answer. Include findings, decisions, risks, open questions, artifact summary, confidence, missing work, source_work_unit_ids, source_artifact_refs, coverage_by_workstream, and confidence_by_section. Important sections and claims must cite the source work-unit ids and artifact refs they rely on.",
      "",
      ...summaries,
    ].join("\n"),
    assigned_agent_id: reducerAgentId || null,
    dependencies: dependencyIds,
    status: "pending",
    result: null,
    result_data: {},
    confidence: null,
    error: null,
    priority: 0,
    expected_output: "Structured reducer synthesis with answer, findings, risks, open questions, artifact_summary, confidence, missing_work, source_work_unit_ids, source_artifact_refs, coverage_by_workstream, and confidence_by_section.",
    review_required: false,
    reviewer_agent_ids: [],
    review_status: "",
    fanout_group_id: "",
    merge_task_id: "",
    source_blueprint_id: "",
    source_event_id: `swarm_reducer:${cleanString(plan.id) || session.id}`,
    runtime_created: true,
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.tasks[taskId] = task;
  if (reducerAgentId && session.agents[reducerAgentId] && ["idle", "done", "blocked"].includes(session.agents[reducerAgentId].status)) {
    session.agents[reducerAgentId].status = "waiting";
  }
  const unit = {
    id: taskId,
    title: task.title,
    description: task.description,
    input: { goal: session.goal, source_task_id: task.id },
    expected_output_schema: { answer: "string", evidence: "array", risks: "array", artifacts: "array", confidence: "number" },
    completion_criteria: ["Return a structured reducer synthesis."],
    assigned_agent_id: reducerAgentId || null,
    dependencies: dependencyIds,
    status: dependencyIds.length > 0 ? "pending" : "ready",
    priority: task.priority,
    attempts: 0,
    max_attempts: numberValue(jsonSafeObject(plan.budgets).max_retry_attempts) ?? 2,
    tool_allowlist: reducerAgentId && session.agents[reducerAgentId] ? session.agents[reducerAgentId].tools : ["cowork_internal"],
    result: {},
    evidence: [],
    risks: [],
    open_questions: [],
    artifacts: [],
    confidence: null,
    error: null,
    source_task_id: task.id,
    source_event_id: task.source_event_id,
    source_work_unit_ids: sourceUnits.map((source) => cleanString(source.id)).filter(Boolean),
    kind: "reducer",
    created_at: timestamp,
    updated_at: timestamp,
  };
  const workUnits = [...swarmWorkUnits(session), unit];
  session.swarm_plan = updateSwarmReadiness({
    ...plan,
    status: "reducing",
    work_units: workUnits,
    updated_at: timestamp,
  }, session, now);
  session.current_focus_task = "Swarm reducer is ready to synthesize completed work units.";
  session.completion_decision = {
    next_action: "reduce_swarm",
    reason: "Required swarm work units are finished; reducer synthesis must run before completion.",
    blocked: [],
    ready_to_finish: false,
    swarm_plan: session.swarm_plan,
    updated_at: timestamp,
  };
  session.events = [
    ...session.events,
    {
      id: idGenerator("evt"),
      type: "swarm.reducer_scheduled",
      message: "Swarm reducer scheduled after required work units finished",
      actor_id: "scheduler",
      data: {
        task_id: task.id,
        source_work_unit_ids: sourceUnits.map((source) => cleanString(source.id)).filter(Boolean),
      },
      created_at: timestamp,
    },
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "swarm",
      name: "Reducer scheduled",
      actor_id: "scheduler",
      status: "pending",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: "",
      output_ref: "",
      summary: "Swarm reducer scheduled after required work units finished",
      data: {
        task_id: task.id,
        source_work_unit_ids: sourceUnits.map((source) => cleanString(source.id)).filter(Boolean),
      },
    },
  ];
  session.updated_at = timestamp;
  return task;
}

function swarmReducerShouldRun(session: CoworkSession): boolean {
  if (session.workflow_mode !== "swarm") {
    return false;
  }
  const plan = jsonSafeObject(session.swarm_plan);
  if (Object.keys(plan).length === 0 || ["completed", "failed", "cancelled", "blocked"].includes(cleanString(plan.status))) {
    return false;
  }
  const baseUnits = swarmWorkUnits(session)
    .filter((unit) => !["reducer", "reviewer"].includes(cleanString(unit.kind)))
    .filter((unit) => cleanString(unit.status) !== "cancelled");
  if (baseUnits.length === 0) {
    return false;
  }
  if (baseUnits.some((unit) => ["pending", "ready", "in_progress", "needs_revision"].includes(cleanString(unit.status) || "pending"))) {
    return false;
  }
  const reducer = existingSwarmGateTask(session, "reducer");
  if (reducer?.status === "completed") {
    session.swarm_plan = {
      ...plan,
      status: "completed",
      updated_at: nowString(session),
    };
    return false;
  }
  return true;
}

function existingSwarmGateTask(session: CoworkSession, kind: "reducer" | "reviewer"): CoworkTask | null {
  const prefix = kind === "reducer" ? "swarm_reducer:" : "swarm_reviewer:";
  return Object.values(session.tasks).find((task) => cleanString(task.source_event_id).startsWith(prefix)) ?? null;
}

function updateSwarmReadiness(planInput: JsonObject, session: CoworkSession, now: () => string): JsonObject {
  const units = Array.isArray(planInput.work_units) ? planInput.work_units.filter(isJsonObject).map(jsonSafeObject) : [];
  const completed = new Set([
    ...units
      .filter((unit) => ["completed", "skipped"].includes(cleanString(unit.status)))
      .map((unit) => cleanString(unit.id))
      .filter(Boolean),
    ...Object.values(session.tasks)
      .filter((task) => ["completed", "skipped"].includes(task.status))
      .map((task) => task.id),
  ]);
  let changed = false;
  for (const unit of units) {
    if ((cleanString(unit.status) || "pending") !== "pending") {
      continue;
    }
    const dependencies = stringList(unit.dependencies);
    if (dependencies.every((dependency) => completed.has(dependency))) {
      unit.status = "ready";
      unit.updated_at = now();
      unit.readiness_reason = {
        completed_dependencies: dependencies.sort(),
        priority: numberValue(unit.priority) ?? 0,
      };
      changed = true;
    }
  }
  return {
    ...planInput,
    work_units: units,
    ...(changed ? { updated_at: now() } : {}),
  };
}

function swarmWorkUnits(session: CoworkSession): JsonObject[] {
  return Array.isArray(session.swarm_plan.work_units)
    ? session.swarm_plan.work_units.filter(isJsonObject).map(jsonSafeObject)
    : [];
}

function nowString(session: CoworkSession): string {
  return cleanString(session.updated_at) || new Date(0).toISOString();
}

function budgetExhaustionReason(
  session: CoworkSession,
  options: { runAgentCalls: number; runAgentCallLimit: number; elapsedWallTimeSeconds: number },
): string {
  const state = budgetState(session);
  const limits = jsonSafeObject(state.limits);
  const usage = jsonSafeObject(state.usage);
  if (options.runAgentCalls >= options.runAgentCallLimit) {
    return "agent_call_budget_exhausted";
  }
  const maxWallTime = numberValue(limits.max_wall_time_seconds);
  if (maxWallTime !== null && options.elapsedWallTimeSeconds >= maxWallTime) {
    return "wall_time_budget_exhausted";
  }
  if (session.workflow_mode === "swarm") {
    const maxWorkUnits = numberValue(limits.max_work_units);
    const workUnits = Array.isArray(session.swarm_plan.work_units) ? session.swarm_plan.work_units : [];
    if (maxWorkUnits !== null && workUnits.length > maxWorkUnits) {
      return "work_unit_budget_exhausted";
    }
  }
  const checks: Array<[string, string, string]> = [
    ["max_agent_calls_total", "agent_calls", "agent_call_budget_exhausted"],
    ["max_tool_calls", "tool_calls", "tool_call_budget_exhausted"],
    ["max_tokens", "tokens_total", "token_budget_exhausted"],
    ["max_cost", "cost", "cost_budget_exhausted"],
  ];
  for (const [limitKey, usageKey, reason] of checks) {
    const limit = numberValue(limits[limitKey]);
    if (limit !== null && (numberValue(usage[usageKey]) ?? 0) >= limit) {
      return reason;
    }
  }
  return "";
}

function stopReasonEventType(reason: string): string {
  if (reason === "agent_call_budget_exhausted") {
    return "scheduler.agent_budget_exhausted";
  }
  if (reason.includes("budget_exhausted")) {
    return "scheduler.budget_exhausted";
  }
  return "scheduler.stop";
}

function stopReasonTraceStatus(reason: string): string {
  return reason.includes("budget_exhausted") || reason === "blocker" ? "blocked" : "completed";
}

function elapsedSeconds(startedAt: string, now: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, (end - start) / 1000);
}

function assessBlockers(session: CoworkSession): { blocked: JsonObject[]; review_blockers: JsonObject[]; fanout_blockers: JsonObject[] } {
  const blocked = Object.values(session.mailbox)
    .filter((record) => Boolean(record.requires_reply))
    .filter((record) => ["delivered", "read"].includes(cleanString(record.status)))
    .map((record) => ({
      id: stringValue(record.id),
      sender_id: stringValue(record.sender_id),
      recipient_ids: Array.isArray(record.recipient_ids) ? record.recipient_ids : [],
      content: cleanString(record.content),
      blocking_task_id: stringValue(record.blocking_task_id),
      request_type: stringValue(record.request_type),
      priority: numberValue(record.priority) ?? 0,
    }));
  const reviewBlockers = Object.values(session.tasks)
    .filter((task) => task.review_required === true)
    .filter((task) => task.status === "completed")
    .filter((task) => !["approved", "passed", "complete"].includes(cleanString(task.review_status)))
    .map((task) => ({
      task_id: task.id,
      title: task.title,
      review_status: task.review_status,
      reviewer_agent_ids: task.reviewer_agent_ids,
    }));
  const fanoutGroups = new Map<string, JsonObject[]>();
  for (const task of Object.values(session.tasks)) {
    const groupId = cleanString(task.fanout_group_id);
    if (!groupId) {
      continue;
    }
    const group = fanoutGroups.get(groupId) ?? [];
    group.push({
      task_id: task.id,
      title: task.title,
      status: task.status,
      merge_task_id: task.merge_task_id,
    });
    fanoutGroups.set(groupId, group);
  }
  const fanoutBlockers = [...fanoutGroups.entries()]
    .filter(([, tasks]) => tasks.some((task) => cleanString(task.status) !== "completed"))
    .map(([fanout_group_id, tasks]) => ({ fanout_group_id, tasks }));
  return {
    blocked,
    review_blockers: reviewBlockers,
    fanout_blockers: fanoutBlockers,
  };
}

function jsonSafeObject(value: unknown): JsonObject {
  return isJsonObject(value) ? { ...value } : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
