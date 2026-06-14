import type { AgentRunner } from "../agent/agentRunner.ts";
import type { AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { Tool, ToolDefinition } from "../tools/tool.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { coworkInternalToolDefinition, createCoworkInternalTool } from "./coworkInternalTool.ts";
import { CoworkMailbox } from "./coworkMailbox.ts";
import { defaultPolicyRegistry } from "./coworkPolicy.ts";
import { normalizeCoworkSession } from "./coworkSerde.ts";
import type { CoworkAgent, CoworkEvent, CoworkSession, CoworkTask } from "./coworkTypes.ts";
import type { CoworkIdGenerator, CoworkServiceStore } from "./coworkService.ts";

export type CoworkAgentRuntimeOptions = {
  store: CoworkServiceStore;
  runner: Pick<AgentRunner, "run">;
  tools?: ToolRegistry;
  model: string;
  now?: () => string;
  idGenerator?: CoworkIdGenerator;
};

export type CoworkRunAgentRequest = {
  sessionId: string;
  agentId: string;
  traceId?: string;
  runId?: string;
  roundId?: string;
  parentSpanId?: string;
};

export type CoworkRunAgentResult = {
  session: CoworkSession | null;
  result: string;
  agentId: string;
  taskId?: string;
};

type CoworkAgentProgress = {
  status: string;
  action: string;
  target_agent_id: string;
  task_title: string;
  action_reason: string;
  public_note: string;
  private_note: string;
  completed_task_ids: string[];
  completed_task_results: JsonObject[];
  new_task_suggestions: JsonObject[];
};

type CoworkStreamEventInput = { type: string; payload: Record<string, unknown> };

type MailboxDraftState = {
  draftId: string;
  toolCallId: string;
  toolCallIndex: number | null;
  toolName: string;
  buffer: string;
  content: string;
  sequence: number;
  emitted: boolean;
  terminal: boolean;
  action: string;
  recipientIds: string[];
  requiresReply: boolean | null;
  topic: string;
  eventType: string;
  requestType: string;
  threadId: string;
};

type ToolObservationStart = {
  startedAt: string;
  parameters: JsonObject;
};

type PendingToolObservation = {
  observation: JsonObject;
  browserObservation?: JsonObject;
  details: JsonObject[];
  sensitiveArtifact?: JsonObject;
  event: CoworkEvent;
};

type ToolObservationState = {
  starts: Map<string, ToolObservationStart[]>;
  pending: PendingToolObservation[];
};

export class CoworkAgentRuntime {
  private readonly store: CoworkServiceStore;
  private readonly runner: Pick<AgentRunner, "run">;
  private readonly tools?: ToolRegistry;
  private readonly model: string;
  private readonly now: () => string;
  private readonly idGenerator: CoworkIdGenerator;

  constructor(options: CoworkAgentRuntimeOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.tools = options.tools;
    this.model = options.model;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  }

  async runAgent(request: CoworkRunAgentRequest): Promise<CoworkRunAgentResult> {
    const traceId = request.traceId ?? "";
    const session = await this.store.readSnapshot(request.sessionId, traceId);
    if (!session) {
      return {
        session: null,
        agentId: request.agentId,
        result: `Error: cowork session '${request.sessionId}' not found`,
      };
    }
    const agent = session.agents[request.agentId];
    if (!agent) {
      return {
        session,
        agentId: request.agentId,
        result: `Error: cowork agent '${request.agentId}' not found`,
      };
    }

    const unread = markAgentInboxRead(session, agent.id);
    const task = selectTaskForAgent(session, agent.id);
    const workUnit = task ? startSwarmWorkUnitForTask(session, task, agent, request, this.now, this.idGenerator) : null;
    if (task) {
      if (!workUnit) {
        task.status = "in_progress";
        task.updated_at = this.now();
      }
      agent.current_task_id = task.id;
      agent.current_task_title = task.title;
      session.current_focus_task = `${task.title}: ${task.description}`;
    } else {
      agent.current_task_id = null;
      agent.current_task_title = null;
    }
    agent.status = "working";
    agent.last_active_at = this.now();
    session.events = [
      ...session.events,
      this.event("agent.started", `${agent.name} started a cowork round`, {
        actorId: agent.id,
        data: { agent_id: agent.id, task_id: task?.id ?? null },
      }),
    ];
    const agentSpanId = this.idGenerator("span");
    session.trace_spans = [
      ...session.trace_spans,
      {
        id: agentSpanId,
        session_id: session.id,
        kind: "agent",
        name: `Run ${agent.name}`,
        run_id: request.runId ?? "",
        round_id: request.roundId ?? "",
        parent_id: request.parentSpanId ?? null,
        actor_id: agent.id,
        status: "running",
        started_at: this.now(),
        ended_at: null,
        input_ref: task?.title ?? "inbox",
        output_ref: "",
        summary: `${agent.name} started`,
        data: {
          agent_id: agent.id,
          task_id: task?.id ?? null,
          unread_message_ids: unread.map((message) => stringValue(message.id)).filter(Boolean),
        },
      },
    ];
    const stepId = this.idGenerator("step");
    session.agent_steps = [
      ...session.agent_steps,
      {
        id: stepId,
        session_id: session.id,
        branch_id: session.current_branch_id || "default",
        architecture: session.branches[session.current_branch_id]?.architecture ?? session.workflow_mode,
        agent_id: agent.id,
        action_kind: "agent_run",
        scheduler_reason: `Scheduler selected ${agent.id} for ${task?.title ?? "inbox work"}`,
        status: "running",
        started_at: this.now(),
        ended_at: null,
        duration_ms: 0,
        task_id: task?.id ?? null,
        work_unit_id: cleanString(workUnit?.id),
        input_summary: task?.description ?? unread.map((message) => stringValue(message.content)).join("\n"),
        output_summary: "",
        error: null,
        linked_message_ids: unread.map((message) => stringValue(message.id)).filter(Boolean),
        linked_artifact_refs: [],
        linked_task_ids: task ? [task.id] : [],
        linked_envelope_ids: [],
        tool_observations: [],
        browser_observations: [],
        summary: null,
        detail_ref: "",
        source_span_id: agentSpanId,
        source_event_id: null,
        projected: false,
      },
    ];
    await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);

    const internalToolRegistration = this.registerInternalTool(session.id, agent.id);
    const streamState = { sequence: 0 };
    const mailboxDrafts = new Map<string, MailboxDraftState>();
    const toolObservationState: ToolObservationState = {
      starts: new Map(),
      pending: [],
    };
    const streamEvents: CoworkEvent[] = [];
    const streamEnabled = wantsAgentStreaming(session);
    const runEventHandler = (event: CoworkStreamEventInput) => {
      if (streamEnabled) {
          const streamEvent = this.agentStreamEvent(agent.id, stepId, streamState, event);
          if (streamEvent) {
            streamEvents.push(streamEvent);
          }
          streamEvents.push(...this.mailboxStreamEvents(session.id, agent.id, mailboxDrafts, event));
      }
      this.recordToolObservationEvent(agent.id, stepId, toolObservationState, event);
    };
    let result: AgentRunResult;
    try {
      result = await this.runner.run(this.agentRunSpec(session, agent, task, unread, request, internalToolRegistration?.definition, runEventHandler, streamEnabled));
    } finally {
      this.restoreInternalTool(internalToolRegistration);
    }
    if (streamEnabled) {
      streamEvents.push(this.agentStreamCompleteEvent(agent.id, stepId, streamState));
    }
    const content = result.finalContent || result.error || "Cowork round completed without a final note.";
    const progress = parseAgentProgress(content);
    const fresh = await this.store.readSnapshot(session.id, traceId) ?? session;
    fresh.events = [...fresh.events, ...streamEvents];
    this.applyToolObservations(fresh, stepId, toolObservationState.pending);
    const freshAgent = fresh.agents[agent.id] ?? agent;
    const freshTask = task ? fresh.tasks[task.id] : undefined;
    this.applyProgress(fresh, freshAgent, freshTask, progress, result, stepId, agentSpanId);
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(fresh), traceId);
    return {
      session: saved,
      agentId: agent.id,
      taskId: task?.id,
      result: `${agent.name} finished with action ${progress.action || "continue"}.`,
    };
  }

  private agentRunSpec(
    session: CoworkSession,
    agent: CoworkAgent,
    task: CoworkTask | undefined,
    unread: JsonObject[],
    request: CoworkRunAgentRequest,
    internalToolDefinition?: ToolDefinition,
    emitEvent?: (event: CoworkStreamEventInput) => void,
    stream = false,
  ): AgentRunSpec {
    return {
      runId: `${request.runId ?? this.idGenerator("run")}:${agent.id}`,
      traceId: request.traceId,
      sessionId: session.id,
      model: this.model,
      maxIterations: 12,
      stream,
      failOnToolError: false,
      tools: internalToolDefinition ? [internalToolDefinition] : [],
      ...(emitEvent ? { emitEvent } : {}),
      messages: [
        {
          role: "system",
          content: buildAgentSystemPrompt(session, agent),
        },
        {
          role: "user",
          content: buildAgentWorkPrompt(session, agent, task, unread),
        },
      ],
      metadata: {
        cowork_session_id: session.id,
        cowork_agent_id: agent.id,
        cowork_task_id: task?.id,
        cowork_round_id: request.roundId,
      },
    };
  }

  private registerInternalTool(sessionId: string, agentId: string): { definition: ToolDefinition; previous?: Tool } | undefined {
    if (!this.tools) {
      return undefined;
    }
    const existing = this.tools.get("cowork_internal");
    this.tools.register(createCoworkInternalTool({
      store: this.store,
      sessionId,
      senderId: agentId,
      now: this.now,
      idGenerator: this.idGenerator,
    }));
    return {
      definition: coworkInternalToolDefinition(),
      ...(existing ? { previous: existing } : {}),
    };
  }

  private restoreInternalTool(registration: { previous?: Tool } | undefined): void {
    if (!registration || !this.tools) {
      return;
    }
    if (registration.previous) {
      this.tools.register(registration.previous);
    } else {
      this.tools.unregister("cowork_internal");
    }
  }

  private agentStreamEvent(
    agentId: string,
    stepId: string,
    state: { sequence: number },
    event: CoworkStreamEventInput,
  ): CoworkEvent | null {
    if (event.type !== "content_delta") {
      return null;
    }
    const text = cleanString(event.payload.delta).slice(0, 2000);
    if (!text) {
      return null;
    }
    state.sequence += 1;
    return this.agentStreamEventRecord(agentId, stepId, {
      phase: "delta",
      status: "running",
      sequence: state.sequence,
      text,
      completed: false,
    });
  }

  private agentStreamCompleteEvent(agentId: string, stepId: string, state: { sequence: number }): CoworkEvent {
    state.sequence += 1;
    return this.agentStreamEventRecord(agentId, stepId, {
      phase: "complete",
      status: "completed",
      sequence: state.sequence,
      text: "",
      completed: true,
    });
  }

  private agentStreamEventRecord(
    agentId: string,
    stepId: string,
    data: { phase: string; status: string; sequence: number; text: string; completed: boolean },
  ): CoworkEvent {
    return {
      id: this.idGenerator("stream"),
      type: "agent.stream",
      message: "Cowork agent stream update",
      actor_id: agentId,
      data: {
        agent_id: agentId,
        step_id: stepId,
        phase: data.phase,
        status: data.status,
        sequence: data.sequence,
        timestamp: this.now(),
        text: data.text,
        completed: data.completed,
      },
      created_at: this.now(),
    };
  }

  private mailboxStreamEvents(
    sessionId: string,
    agentId: string,
    drafts: Map<string, MailboxDraftState>,
    event: CoworkStreamEventInput,
  ): CoworkEvent[] {
    if (event.type !== "tool_call_delta") {
      return [];
    }
    const state = mailboxDraftState(sessionId, agentId, drafts, event.payload);
    feedMailboxDraftState(state, event.payload);
    const events: CoworkEvent[] = [];
    if (mailboxDraftCanEmit(state)) {
      const nextText = mailboxDraftNextText(state);
      if (nextText) {
        state.emitted = true;
        events.push(this.mailboxStreamEventRecord(agentId, state, {
          phase: "delta",
          status: "streaming",
          text: nextText,
          completed: false,
        }));
      }
    }
    if (mailboxToolCallTerminal(event.payload)) {
      const terminal = this.mailboxStreamTerminalEvent(agentId, state, event.payload);
      if (terminal) {
        events.push(terminal);
      }
    }
    return events;
  }

  private mailboxStreamTerminalEvent(agentId: string, state: MailboxDraftState, payload: Record<string, unknown>): CoworkEvent | null {
    if (state.terminal || !mailboxDraftCanEmit(state)) {
      return null;
    }
    const nextText = mailboxDraftNextText(state);
    const status = mailboxTerminalStatus(payload);
    state.terminal = true;
    state.emitted = true;
    return this.mailboxStreamEventRecord(agentId, state, {
      phase: "terminal",
      status,
      text: nextText,
      completed: status === "completed",
    });
  }

  private mailboxStreamEventRecord(
    agentId: string,
    state: MailboxDraftState,
    data: { phase: "delta" | "terminal"; status: string; text: string; completed: boolean },
  ): CoworkEvent {
    state.sequence += 1;
    return {
      id: this.idGenerator("mailbox_stream"),
      type: "mailbox.stream",
      message: "Cowork mailbox draft stream update",
      actor_id: agentId,
      data: {
        sender_agent_id: agentId,
        draft_id: state.draftId,
        tool_call_id: state.toolCallId,
        phase: data.phase,
        status: data.status,
        sequence: state.sequence,
        timestamp: this.now(),
        text: data.text.slice(0, 2000),
        completed: data.completed,
        recipient_ids: state.recipientIds,
        requires_reply: state.requiresReply,
        topic: state.topic,
        event_type: state.eventType,
        request_type: state.requestType,
        thread_id: state.threadId,
      },
      created_at: this.now(),
    };
  }

  private recordToolObservationEvent(
    agentId: string,
    stepId: string,
    state: ToolObservationState,
    event: CoworkStreamEventInput,
  ): void {
    if (event.type === "tool_start") {
      const toolName = cleanString(event.payload.toolName);
      if (!toolName) {
        return;
      }
      const key = toolObservationKey(event.payload);
      const starts = state.starts.get(key) ?? [];
      starts.push({
        startedAt: this.now(),
        parameters: jsonSafeObject(event.payload.args),
      });
      state.starts.set(key, starts);
      return;
    }
    if (event.type !== "tool_result") {
      return;
    }
    const toolName = cleanString(event.payload.toolName);
    if (!toolName) {
      return;
    }
    const key = toolObservationKey(event.payload);
    const starts = state.starts.get(key) ?? [];
    const started = starts.shift() ?? { startedAt: this.now(), parameters: {} };
    const endedAt = this.now();
    const result = cleanString(event.payload.content);
    const status = result.trimStart().startsWith("Error") ? "failed" : "completed";
    const observationId = this.idGenerator("toolobs");
    const detailId = this.idGenerator("obsdetail");
    const resultSummary = compactText(result, 400);
    const purpose = compactText(`${agentId || "agent"} called ${toolName}`, 240);
    const parameterSummary = started.parameters;
    const details: JsonObject[] = [{
      id: detailId,
      subject_id: observationId,
      subject_type: "tool_observation",
      state: "available",
      summary: resultSummary,
      content: result,
      content_type: "text/plain",
      redacted: false,
      sensitivity: "",
      unavailable_reason: "",
      permitted_agent_ids: [],
      artifact_refs: [],
      created_at: endedAt,
    }];
    const browserProjection = this.browserObservationProjection({
      agentId,
      stepId,
      toolName,
      parameters: parameterSummary,
      purpose,
      result,
      resultSummary,
      status,
      startedAt: started.startedAt,
      endedAt,
      sourceDetailId: detailId,
    });
    if (browserProjection) {
      details.push(browserProjection.detail);
    }
    state.pending.push({
      observation: {
        id: observationId,
        step_id: stepId,
        tool_name: toolName,
        calling_agent_id: agentId,
        purpose,
        parameter_summary: parameterSummary,
        result_summary: resultSummary,
        status,
        started_at: started.startedAt,
        ended_at: endedAt,
        duration_ms: durationMs(started.startedAt, endedAt),
        detail_ref: detailId,
        redacted: false,
      },
      ...(browserProjection ? {
        browserObservation: browserProjection.observation,
        sensitiveArtifact: browserProjection.sensitiveArtifact,
      } : {}),
      details,
      event: this.event("cowork.observation.available", "Cowork tool observation available", {
        actorId: agentId,
        data: {
          observation_id: observationId,
          detail_ref: detailId,
          step_id: stepId,
          tool_name: toolName,
          status,
        },
      }),
    });
  }

  private browserObservationProjection(input: {
    agentId: string;
    stepId: string;
    toolName: string;
    parameters: JsonObject;
    purpose: string;
    result: string;
    resultSummary: string;
    status: string;
    startedAt: string;
    endedAt: string;
    sourceDetailId: string;
  }): { observation: JsonObject; detail: JsonObject; sensitiveArtifact?: JsonObject } | null {
    if (!looksLikeBrowserTool(input.toolName, input.parameters)) {
      return null;
    }
    const resourceRef = browserResourceRef(input.parameters);
    const sensitive = looksSensitiveResource(input.parameters);
    const observationId = this.idGenerator("browserobs");
    const detailId = this.idGenerator("obsdetail");
    const observation = {
      id: observationId,
      step_id: input.stepId,
      purpose: input.purpose,
      resource_ref: compactText(resourceRef, 500),
      title: "",
      result_summary: input.resultSummary,
      status: input.status,
      accessed_at: input.startedAt,
      ended_at: input.endedAt,
      duration_ms: durationMs(input.startedAt, input.endedAt),
      artifact_refs: input.sourceDetailId ? [input.sourceDetailId] : [],
      detail_ref: detailId,
      sensitive,
      redacted: sensitive,
    };
    const detail = {
      id: detailId,
      subject_id: observationId,
      subject_type: "browser_observation",
      state: "available",
      summary: input.resultSummary,
      content: input.result,
      content_type: "text/plain",
      redacted: sensitive,
      sensitivity: sensitive ? "sensitive" : "",
      unavailable_reason: "",
      permitted_agent_ids: [],
      artifact_refs: observation.artifact_refs,
      created_at: input.endedAt,
    };
    const sensitiveArtifact = sensitive ? {
      id: this.idGenerator("sartifact"),
      source_step_id: input.stepId,
      source_observation_id: observationId,
      summary: input.resultSummary,
      artifact_ref: detailId,
      sensitivity: "sensitive",
      permitted_agent_ids: [],
      redacted: true,
      created_at: input.endedAt,
    } : undefined;
    return {
      observation,
      detail,
      ...(sensitiveArtifact ? { sensitiveArtifact } : {}),
    };
  }

  private applyToolObservations(session: CoworkSession, stepId: string, pending: PendingToolObservation[]): void {
    if (pending.length === 0) {
      return;
    }
    const observations = pending.map((item) => item.observation);
    const browserObservations = pending
      .map((item) => item.browserObservation)
      .filter(isJsonObject)
      .map(jsonSafeObject);
    session.agent_steps = session.agent_steps.map((step) => {
      if (stringValue(step.id) !== stepId) {
        return step;
      }
      return {
        ...step,
        tool_observations: [
          ...objectList(step.tool_observations),
          ...observations,
        ],
        browser_observations: [
          ...objectList(step.browser_observations),
          ...browserObservations,
        ],
      };
    });
    session.observation_details = {
      ...session.observation_details,
      ...Object.fromEntries(pending.flatMap((item) => item.details).map((detail) => [stringValue(detail.id), detail])),
    };
    session.sensitive_artifacts = {
      ...session.sensitive_artifacts,
      ...Object.fromEntries(pending
        .map((item) => item.sensitiveArtifact)
        .filter(isJsonObject)
        .map((artifact) => [stringValue(artifact.id), artifact])),
    };
    session.events = [
      ...session.events,
      ...pending.map((item) => item.event),
    ];
  }

  private applyProgress(
    session: CoworkSession,
    agent: CoworkAgent,
    task: CoworkTask | undefined,
    progress: CoworkAgentProgress,
    result: AgentRunResult,
    stepId: string,
    agentSpanId: string,
  ): void {
    const linkedTaskIds = new Set<string>();
    if (task) {
      linkedTaskIds.add(task.id);
    }
    for (const taskId of progress.completed_task_ids) {
      const target = session.tasks[taskId];
      if (!target) {
        continue;
      }
      const payload = progress.completed_task_results.find((item) => stringValue(item.task_id) === taskId);
      target.status = "completed";
      target.result = payload ? JSON.stringify(payload) : progress.public_note || progress.private_note || result.finalContent;
      target.result_data = payload ?? {};
      target.confidence = numberValue(payload?.confidence);
      target.error = null;
      target.updated_at = this.now();
      syncCompletedSwarmWorkUnitFromTask(session, target, agent.id, payload, this.now, this.idGenerator);
      processSwarmGateResult(session, target, agent.id, this.now, this.idGenerator);
      replanSwarmFollowUps(session, target, this.now, this.idGenerator);
      linkedTaskIds.add(taskId);
      session.events = [
        ...session.events,
        this.event("task.completed", `Task '${target.title}' completed by ${agent.name}`, {
          actorId: agent.id,
          data: { task_id: taskId, confidence: target.confidence },
        }),
      ];
    }
    if (task && progress.status === "failed" && !progress.completed_task_ids.includes(task.id)) {
      const message = progress.public_note || progress.private_note || result.error || result.finalContent || "Task failed.";
      task.status = "failed";
      task.result = message;
      task.result_data = {};
      task.confidence = null;
      task.error = message;
      task.updated_at = this.now();
      syncFailedSwarmWorkUnitFromTask(session, task, agent.id, message, this.now, this.idGenerator);
      replanSwarmFailedSplit(session, task, this.now, this.idGenerator);
      linkedTaskIds.add(task.id);
      session.events = [
        ...session.events,
        this.event("task.failed", `Task '${task.title}' failed by ${agent.name}`, {
          actorId: agent.id,
          data: { task_id: task.id, error: message },
        }),
      ];
    }
    for (const suggestion of progress.new_task_suggestions) {
      const title = cleanString(suggestion.title);
      if (!title) {
        continue;
      }
      const taskId = this.idGenerator("task");
      session.tasks[taskId] = {
        id: taskId,
        title,
        description: cleanString(suggestion.description) || title,
        assigned_agent_id: cleanString(suggestion.assigned_agent_id) || agent.id,
        dependencies: stringList(suggestion.dependencies),
        status: "pending",
        result: null,
        result_data: {},
        confidence: null,
        error: null,
        priority: numberValue(suggestion.priority) ?? 0,
        expected_output: cleanString(suggestion.expected_output),
        review_required: suggestion.review_required === true,
        reviewer_agent_ids: stringList(suggestion.reviewer_agent_ids),
        review_status: "",
        fanout_group_id: cleanString(suggestion.fanout_group_id),
        merge_task_id: cleanString(suggestion.merge_task_id),
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: true,
        created_at: this.now(),
        updated_at: this.now(),
      };
      session.events = [
        ...session.events,
        this.event("task.created", `Task '${title}' suggested by ${agent.name}`, {
          actorId: agent.id,
          data: { task_id: taskId },
        }),
      ];
    }

    agent.status = progress.action === "block" ? "blocked" : progress.status;
    agent.private_summary = appendSummary(agent.private_summary, progress.private_note || progress.public_note || result.finalContent);
    agent.current_task_id = null;
    agent.current_task_title = null;
    agent.rounds += 1;
    agent.last_active_at = this.now();
    session.trace_spans = session.trace_spans.map((span) => {
      if (stringValue(span.id) !== agentSpanId) {
        return span;
      }
      return {
        ...span,
        status: progress.status === "failed" ? "failed" : "completed",
        ended_at: this.now(),
        output_ref: progress.public_note || progress.private_note || result.finalContent,
        summary: `${agent.name} finished with action ${progress.action}`,
        data: {
          ...jsonSafeObject(span.data),
          progress,
          tools_used: result.toolsUsed,
        },
      };
    });
    session.agent_steps = session.agent_steps.map((step) => {
      if (stringValue(step.id) !== stepId) {
        return step;
      }
      return {
        ...step,
        status: progress.status === "failed" ? "failed" : "completed",
        ended_at: this.now(),
        output_summary: progress.public_note || progress.private_note || result.finalContent,
        linked_task_ids: [...linkedTaskIds],
        summary: progress.public_note || progress.private_note || result.finalContent,
        detail_ref: stepId,
      };
    });
    if (progress.public_note) {
      appendAgentMessage(session, agent.id, progress.public_note, this.idGenerator, this.now);
    }
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
}

function markAgentInboxRead(session: CoworkSession, agentId: string): JsonObject[] {
  const agent = session.agents[agentId];
  if (!agent) {
    return [];
  }
  const unread = agent.inbox.map((id) => session.messages[id]).filter(isJsonObject).map(jsonSafeObject);
  for (const message of unread) {
    const readBy = new Set(stringList(message.read_by));
    readBy.add(agentId);
    message.read_by = [...readBy];
    session.messages[stringValue(message.id)] = message;
  }
  agent.inbox = [];
  return unread;
}

function wantsAgentStreaming(session: CoworkSession): boolean {
  const runtimeState = jsonSafeObject(session.runtime_state);
  return cleanString(runtimeState.origin_channel) === "websocket"
    && cleanString(runtimeState.origin_surface) === "main_chat"
    && Boolean(cleanString(runtimeState.origin_chat_id));
}

function toolObservationKey(payload: Record<string, unknown>): string {
  return `${cleanString(payload.runId)}:${cleanString(payload.toolCallId)}:${cleanString(payload.toolName)}`;
}

function looksLikeBrowserTool(toolName: string, parameters: JsonObject): boolean {
  const lowered = toolName.toLowerCase();
  return ["browser", "browse", "web", "url"].some((part) => lowered.includes(part))
    || Object.prototype.hasOwnProperty.call(parameters, "url");
}

function browserResourceRef(parameters: JsonObject): string {
  return cleanString(parameters.url) || cleanString(parameters.resource) || cleanString(parameters.query);
}

function looksSensitiveResource(parameters: JsonObject): boolean {
  const resource = (cleanString(parameters.url) || cleanString(parameters.resource)).toLowerCase();
  return resource.startsWith("file:") || resource.includes("localhost") || resource.includes("127.0.0.1");
}

function durationMs(startedAt: string, endedAt: string): number | null {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) {
    return null;
  }
  return Math.max(0, ended - started);
}

function compactText(value: unknown, limit: number): string {
  const text = cleanString(value);
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return text.slice(0, limit);
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function mailboxDraftState(
  sessionId: string,
  agentId: string,
  drafts: Map<string, MailboxDraftState>,
  payload: Record<string, unknown>,
): MailboxDraftState {
  const toolCallId = cleanString(payload.toolCallId);
  const index = numberValue(payload.toolCallIndex) ?? numberValue(payload.index);
  const key = toolCallId || `index:${index ?? "unknown"}`;
  const existing = drafts.get(key);
  if (existing) {
    return existing;
  }
  const state: MailboxDraftState = {
    draftId: `${sessionId}:${agentId}:${key}`,
    toolCallId: toolCallId || key,
    toolCallIndex: index,
    toolName: "",
    buffer: "",
    content: "",
    sequence: 0,
    emitted: false,
    terminal: false,
    action: "",
    recipientIds: [],
    requiresReply: null,
    topic: "",
    eventType: "",
    requestType: "",
    threadId: "",
  };
  drafts.set(key, state);
  return state;
}

function feedMailboxDraftState(state: MailboxDraftState, payload: Record<string, unknown>): void {
  const toolName = cleanString(payload.toolName);
  if (toolName) {
    state.toolName = toolName;
  }
  const deltaText = typeof payload.deltaText === "string" ? payload.deltaText : "";
  if (deltaText) {
    state.buffer = `${state.buffer}${deltaText}`.slice(-32000);
  }
  state.action = extractJsonStringField(state.buffer, "action") || state.action;
  const recipientIds = extractJsonStringArrayField(state.buffer, "recipient_ids");
  if (recipientIds.length > 0) {
    state.recipientIds = recipientIds;
  }
  const requiresReply = extractJsonBoolField(state.buffer, "requires_reply");
  if (requiresReply !== null) {
    state.requiresReply = requiresReply;
  }
  state.topic = extractJsonStringField(state.buffer, "topic") || state.topic;
  state.eventType = extractJsonStringField(state.buffer, "event_type") || state.eventType;
  state.requestType = extractJsonStringField(state.buffer, "request_type") || state.requestType;
  state.threadId = extractJsonStringField(state.buffer, "thread_id") || state.threadId;
}

function mailboxDraftCanEmit(state: MailboxDraftState): boolean {
  return state.toolName === "cowork_internal" && state.action === "send_message";
}

function mailboxDraftNextText(state: MailboxDraftState): string {
  const content = extractJsonStringFieldPrefix(state.buffer, "content");
  if (content.length <= state.content.length) {
    return "";
  }
  const next = content.slice(state.content.length);
  state.content = content;
  return next;
}

function mailboxToolCallTerminal(payload: Record<string, unknown>): boolean {
  const status = cleanString(payload.status).toLowerCase();
  return payload.completed === true
    || cleanString(payload.phase).toLowerCase() === "terminal"
    || ["completed", "failed", "error", "interrupted", "discarded"].includes(status);
}

function mailboxTerminalStatus(payload: Record<string, unknown>): string {
  const status = cleanString(payload.status).toLowerCase();
  if (status === "error") {
    return "failed";
  }
  if (["completed", "failed", "interrupted", "discarded"].includes(status)) {
    return status;
  }
  return payload.completed === true ? "completed" : "completed";
}

function extractJsonStringField(buffer: string, field: string): string {
  const value = extractJsonStringFieldPrefix(buffer, field);
  const fieldStart = jsonFieldValueStart(buffer, field);
  if (fieldStart < 0) {
    return "";
  }
  return jsonStringIsClosed(buffer, fieldStart) ? value : "";
}

function extractJsonStringFieldPrefix(buffer: string, field: string): string {
  const start = jsonFieldValueStart(buffer, field);
  if (start < 0) {
    return "";
  }
  return readJsonStringPrefix(buffer, start);
}

function jsonFieldValueStart(buffer: string, field: string): number {
  const pattern = new RegExp(`["']${escapeRegExp(field)}["']\\s*:\\s*["']`, "i");
  const match = pattern.exec(buffer);
  return match ? match.index + match[0].length : -1;
}

function readJsonStringPrefix(buffer: string, start: number): string {
  let out = "";
  for (let index = start; index < buffer.length; index += 1) {
    const ch = buffer[index];
    if (ch === "\\") {
      const next = buffer[index + 1];
      if (next === undefined) {
        break;
      }
      out += decodeJsonEscape(next);
      index += 1;
      continue;
    }
    if (ch === "\"") {
      break;
    }
    out += ch;
  }
  return out;
}

function jsonStringIsClosed(buffer: string, start: number): boolean {
  let escaped = false;
  for (let index = start; index < buffer.length; index += 1) {
    const ch = buffer[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      return true;
    }
  }
  return false;
}

function decodeJsonEscape(ch: string): string {
  if (ch === "n") {
    return "\n";
  }
  if (ch === "r") {
    return "\r";
  }
  if (ch === "t") {
    return "\t";
  }
  if (ch === "b") {
    return "\b";
  }
  if (ch === "f") {
    return "\f";
  }
  return ch;
}

function extractJsonStringArrayField(buffer: string, field: string): string[] {
  const pattern = new RegExp(`["']${escapeRegExp(field)}["']\\s*:\\s*\\[([^\\]]*)\\]`, "i");
  const match = pattern.exec(buffer);
  if (!match) {
    return [];
  }
  return Array.from(match[1].matchAll(/["']((?:\\.|[^"'\\])*)["']/g))
    .map((entry) => unescapeJsonString(entry[1]).trim())
    .filter(Boolean);
}

function extractJsonBoolField(buffer: string, field: string): boolean | null {
  const pattern = new RegExp(`["']${escapeRegExp(field)}["']\\s*:\\s*(true|false)`, "i");
  const match = pattern.exec(buffer);
  return match ? match[1].toLowerCase() === "true" : null;
}

function unescapeJsonString(value: string): string {
  return value.replace(/\\(.)/g, (_match, ch: string) => decodeJsonEscape(ch));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CoworkReadyAgentSelection = {
  agents: CoworkAgent[];
  candidateScores: JsonObject;
  reasonProfile: string;
};

export function selectReadyCoworkAgentCandidates(session: CoworkSession, limit: number): CoworkReadyAgentSelection {
  if (session.status !== "active") {
    return {
      agents: [],
      candidateScores: {},
      reasonProfile: "inactive session",
    };
  }
  refreshMailboxReadinessState(session);
  if (session.workflow_mode === "swarm") {
    return selectSwarmReadyAgents(session, limit);
  }
  return selectTeamReadyAgents(session, limit);
}

export function selectReadyCoworkAgents(session: CoworkSession, limit: number): CoworkAgent[] {
  return selectReadyCoworkAgentCandidates(session, limit).agents;
}

function refreshMailboxReadinessState(session: CoworkSession): void {
  const mailbox = new CoworkMailbox();
  mailbox.expireRecords(session);
  mailbox.escalateStaleBlockers(session);
}

function selectTeamReadyAgents(session: CoworkSession, limit: number): CoworkReadyAgentSelection {
  const candidates: Array<{ agent: CoworkAgent; score: number }> = [];
  const candidateScores: JsonObject = {};
  const profile = defaultPolicyRegistry().resolve(session.workflow_mode).runtimeProfile;
  const leadId = leadAgentId(session);
  let unassignedReadySlots = unassignedReadyTasks(session).length;
  for (const agent of Object.values(session.agents)) {
    if (!isSelectableAgentStatus(agent)) {
      continue;
    }
    const hasDirectWork = Boolean(selectDirectTaskForAgent(session, agent.id)) || agent.inbox.length > 0 || hasPendingMailboxWork(session, agent.id);
    const canClaimShared = ["hybrid", "team", "shared_state", "message_bus"].includes(profile);
    let hasSharedTask = canClaimShared && !hasDirectWork && unassignedReadySlots > 0;
    if (profile === "orchestrator" && !hasDirectWork && agent.id !== leadId) {
      hasSharedTask = false;
    }
    if (hasDirectWork || hasSharedTask) {
      const score = teamReadinessScore(session, agent, profile, hasSharedTask);
      candidates.push({ agent, score });
      candidateScores[agent.id] = score;
      if (hasSharedTask) {
        unassignedReadySlots -= 1;
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const ready = candidates.slice(0, Math.max(1, limit)).map((candidate) => candidate.agent);
  return {
    agents: ready,
    candidateScores,
    reasonProfile: "team readiness scoring",
  };
}

function teamReadinessScore(session: CoworkSession, agent: CoworkAgent, profile: string, hasSharedTask: boolean): number {
  let score = 0;
  score += Math.min(agent.inbox.length, 5) * 8;
  score += agentMailboxPressure(session, agent.id);
  if (selectDirectTaskForAgent(session, agent.id)) {
    score += 45;
  }
  if (hasSharedTask) {
    score += 18;
  }
  if (agent.status === "blocked") {
    score -= 25;
  }
  if (agent.status === "waiting") {
    score += 10;
  }
  if (agent.current_task_id) {
    score += 8;
  }
  const rounds = numberValue(agent.rounds);
  if (rounds !== null && rounds > 0) {
    score -= Math.min(rounds, 8);
  }
  const leadId = leadAgentId(session);
  if (profile === "orchestrator") {
    score += agent.id === leadId ? 25 : -12;
  } else if (profile === "team") {
    score += agent.id !== leadId ? 10 : 0;
  } else if (profile === "peer_handoff") {
    score += agent.current_task_id || selectDirectTaskForAgent(session, agent.id) ? 30 : 0;
  } else if (profile === "generator_verifier") {
    const reviewer = isReviewerLikeAgent(agent);
    const hasPendingReview = Object.values(session.tasks).some((task) => task.status === "pending"
      && task.assigned_agent_id === agent.id
      && looksLikeReviewTask(task.title, task.description));
    score += reviewer && hasPendingReview ? 40 : 0;
    score -= reviewer && !hasPendingReview ? 8 : 0;
  }
  return score;
}

function hasPendingMailboxWork(session: CoworkSession, agentId: string): boolean {
  return Object.values(session.mailbox).some((record) => Array.isArray(record.recipient_ids)
    && record.recipient_ids.map(cleanString).includes(agentId)
    && record.requires_reply === true
    && ["delivered", "read"].includes(cleanString(record.status)));
}

function agentMailboxPressure(session: CoworkSession, agentId: string): number {
  const agent = session.agents[agentId];
  if (!agent) {
    return 0;
  }
  let pressure = 0;
  for (const record of Object.values(session.mailbox)) {
    if (!Array.isArray(record.recipient_ids) || !record.recipient_ids.map(cleanString).includes(agentId) || ["replied", "expired"].includes(cleanString(record.status))) {
      continue;
    }
    const priority = numberValue(record.priority) ?? 0;
    if (cleanString(record.message_id) && agent.inbox.includes(cleanString(record.message_id))) {
      pressure = Math.max(pressure, priority);
    }
    if (record.requires_reply === true && ["delivered", "read"].includes(cleanString(record.status))) {
      pressure = Math.max(pressure, priority + 20);
    }
  }
  return pressure;
}

function isReviewerLikeAgent(agent: CoworkAgent): boolean {
  const text = `${agent.id} ${agent.name} ${agent.role}`.toLowerCase();
  return text.includes("review") || text.includes("verify") || text.includes("validator");
}

function looksLikeReviewTask(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return text.includes("review") || text.includes("verify") || text.includes("validate") || text.includes("check");
}

function selectSwarmReadyAgents(session: CoworkSession, limit: number): CoworkReadyAgentSelection {
  const parallelWidth = Math.max(1, Math.trunc(numberValue(session.budget_limits.parallel_width) ?? 1));
  const activeAgentCount = Object.values(session.agents)
    .filter((agent) => agent.status === "working" && agent.lifecycle_status !== "retired")
    .length;
  const slots = Math.max(0, Math.min(Math.max(1, Math.trunc(limit || 1)), parallelWidth) - activeAgentCount);
  if (slots <= 0) {
    return {
      agents: [],
      candidateScores: {},
      reasonProfile: "swarm workstream readiness scoring",
    };
  }
  const orderedUnits = swarmReadyUnits(session);
  const runningSignatures = new Set(swarmWorkUnits(session)
    .filter((unit) => cleanString(unit.status) === "in_progress")
    .map(swarmUnitSignature));
  const agents: CoworkAgent[] = [];
  const candidateScores: JsonObject = {};
  const selectedAgentIds = new Set<string>();
  for (const unit of orderedUnits) {
    const signature = swarmUnitSignature(unit);
    if (runningSignatures.has(signature)) {
      continue;
    }
    const agentId = cleanString(unit.assigned_agent_id);
    const agent = session.agents[agentId];
    if (!agent || selectedAgentIds.has(agent.id) || !isSelectableAgentStatus(agent)) {
      continue;
    }
    const task = taskForSwarmUnit(session, unit, agent.id);
    if (!task) {
      continue;
    }
    agents.push(agent);
    selectedAgentIds.add(agent.id);
    candidateScores[agent.id] = {
      score: 1,
      rank: agents.length,
      work_unit_id: cleanString(unit.id),
      source_task_id: task.id,
      workstream: swarmWorkstream(unit),
      status: cleanString(unit.status) || "pending",
      priority: numberValue(unit.priority) ?? 0,
    };
    runningSignatures.add(signature);
    if (agents.length >= slots) {
      break;
    }
  }
  return {
    agents,
    candidateScores,
    reasonProfile: "swarm workstream readiness scoring",
  };
}

function swarmWorkUnits(session: CoworkSession): JsonObject[] {
  return Array.isArray(session.swarm_plan.work_units)
    ? session.swarm_plan.work_units.filter(isJsonObject).map(jsonSafeObject)
    : [];
}

function swarmReadyUnits(session: CoworkSession): JsonObject[] {
  const units = swarmWorkUnits(session);
  const completed = new Set([
    ...units
      .filter((unit) => ["completed", "skipped"].includes(cleanString(unit.status)))
      .map((unit) => cleanString(unit.id))
      .filter(Boolean),
    ...Object.values(session.tasks)
      .filter((task) => ["completed", "skipped"].includes(task.status))
      .map((task) => task.id),
  ]);
  const ready: JsonObject[] = [];
  const failedRetry: JsonObject[] = [];
  for (const unit of units) {
    const status = cleanString(unit.status) || "pending";
    if (["failed", "needs_revision"].includes(status)) {
      const attempts = Math.trunc(numberValue(unit.attempts) ?? 0);
      const maxAttempts = Math.trunc(numberValue(unit.max_attempts) ?? 1);
      if (attempts < maxAttempts) {
        failedRetry.push(unit);
      }
      continue;
    }
    if (
      ["pending", "ready"].includes(status)
      && stringList(unit.dependencies).every((dependency) => completed.has(dependency))
    ) {
      ready.push(unit);
    }
  }
  return [
    ...fairOrderByWorkstream(sortSwarmQueueUnits(ready)),
    ...fairOrderByWorkstream(sortSwarmQueueUnits(failedRetry)),
  ];
}

function sortSwarmQueueUnits(units: JsonObject[]): JsonObject[] {
  return [...units].sort((left, right) => (numberValue(right.priority) ?? 0) - (numberValue(left.priority) ?? 0)
    || cleanString(left.created_at).localeCompare(cleanString(right.created_at))
    || cleanString(left.id).localeCompare(cleanString(right.id)));
}

function fairOrderByWorkstream(units: JsonObject[]): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const unit of units) {
    const workstream = swarmWorkstream(unit);
    const group = groups.get(workstream) ?? [];
    group.push(unit);
    groups.set(workstream, group);
  }
  const ordered: JsonObject[] = [];
  while ([...groups.values()].some((group) => group.length > 0)) {
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key);
      const unit = group?.shift();
      if (unit) {
        ordered.push(unit);
      }
    }
  }
  return ordered;
}

function swarmUnitSignature(unit: JsonObject): string {
  const title = cleanString(unit.title).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const description = cleanString(unit.description).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return stableStringify({
    title,
    description,
    input: isJsonObject(unit.input) ? unit.input : {},
    schema: isJsonObject(unit.expected_output_schema) ? unit.expected_output_schema : {},
  });
}

function taskForSwarmUnit(session: CoworkSession, unit: JsonObject, agentId: string): CoworkTask | undefined {
  const taskId = cleanString(unit.source_task_id) || cleanString(unit.task_id) || cleanString(unit.id);
  const task = session.tasks[taskId];
  if (!task) {
    return selectTaskForAgent(session, agentId);
  }
  if (
    ["in_progress", "completed", "skipped"].includes(task.status)
    || (task.assigned_agent_id && task.assigned_agent_id !== agentId)
  ) {
    return undefined;
  }
  const completed = new Set(Object.values(session.tasks)
    .filter((candidate) => ["completed", "skipped"].includes(candidate.status))
    .map((candidate) => candidate.id));
  return task.dependencies.every((dependency) => completed.has(dependency)) ? task : undefined;
}

function swarmWorkstream(unit: JsonObject): string {
  return cleanString(unit.workstream_id)
    || cleanString(unit.workstream)
    || cleanString(unit.team_id)
    || cleanString(unit.fanout_group_id)
    || cleanString(unit.kind)
    || "default";
}

function startSwarmWorkUnitForTask(
  session: CoworkSession,
  task: CoworkTask,
  agent: CoworkAgent,
  request: CoworkRunAgentRequest,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): JsonObject | null {
  if (session.workflow_mode !== "swarm") {
    return null;
  }
  const unit = swarmWorkUnitForTask(session, task.id);
  if (!unit) {
    return null;
  }
  const status = cleanString(unit.status) || "pending";
  if (status !== "in_progress" && ["ready", "pending", "failed", "needs_revision"].includes(status) && swarmWorkUnitDependenciesMet(session, unit)) {
    const timestamp = now();
    unit.status = "in_progress";
    unit.assigned_agent_id = agent.id;
    unit.updated_at = timestamp;
    task.status = "in_progress";
    task.assigned_agent_id = agent.id;
    task.updated_at = timestamp;
    agent.status = "working";
    agent.current_task_id = task.id;
    agent.current_task_title = task.title;
    session.trace_spans = [
      ...session.trace_spans,
      {
        id: idGenerator("span"),
        session_id: session.id,
        kind: "swarm",
        name: "Work unit started",
        run_id: request.runId ?? "",
        round_id: request.roundId ?? "",
        parent_id: request.parentSpanId ?? null,
        actor_id: agent.id,
        status: "in_progress",
        started_at: timestamp,
        ended_at: timestamp,
        input_ref: task.title,
        output_ref: "",
        summary: `${agent.name} started work unit '${cleanString(unit.title) || cleanString(unit.id)}'`,
        data: {
          work_unit_id: cleanString(unit.id),
          agent_id: agent.id,
          source_task_id: task.id,
        },
      },
    ];
  }
  return unit;
}

function syncCompletedSwarmWorkUnitFromTask(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  payload: JsonObject | undefined,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  if (session.workflow_mode !== "swarm") {
    return;
  }
  const unit = swarmWorkUnitForTask(session, task.id);
  if (!unit) {
    return;
  }
  const result = Object.keys(payload ?? {}).length > 0 ? jsonSafeObject(payload) : { answer: task.result ?? "" };
  const confidence = numberValue(result.confidence);
  unit.status = "completed";
  unit.result = result;
  unit.evidence = Array.isArray(result.evidence) ? result.evidence : [];
  unit.risks = Array.isArray(result.risks) ? result.risks : [];
  unit.open_questions = Array.isArray(result.open_questions) ? result.open_questions : [];
  unit.artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  unit.confidence = confidence;
  unit.error = null;
  unit.updated_at = now();
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "swarm",
      name: "Work unit completed",
      run_id: "",
      round_id: "",
      parent_id: null,
      actor_id: cleanString(unit.assigned_agent_id) || agentId,
      status: "completed",
      started_at: unit.updated_at,
      ended_at: unit.updated_at,
      input_ref: task.title,
      output_ref: cleanString(result.answer) || task.result || "",
      summary: `Work unit '${cleanString(unit.title) || cleanString(unit.id)}' completed`,
      data: {
        work_unit_id: cleanString(unit.id),
        source_task_id: task.id,
        confidence,
      },
    },
  ];
  refreshSwarmWorkUnitReadiness(session, now);
}

function syncFailedSwarmWorkUnitFromTask(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  error: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  if (session.workflow_mode !== "swarm") {
    return;
  }
  const unit = swarmWorkUnitForTask(session, task.id);
  if (!unit) {
    return;
  }
  const timestamp = now();
  unit.status = "failed";
  unit.error = error;
  unit.result = { error };
  unit.updated_at = timestamp;
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "swarm",
      name: "Work unit failed",
      run_id: "",
      round_id: "",
      parent_id: null,
      actor_id: cleanString(unit.assigned_agent_id) || agentId,
      status: "failed",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: task.title,
      output_ref: error,
      summary: `Work unit '${cleanString(unit.title) || cleanString(unit.id)}' failed`,
      data: {
        work_unit_id: cleanString(unit.id),
        source_task_id: task.id,
      },
      error,
    },
  ];
}

function processSwarmGateResult(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  if (session.workflow_mode !== "swarm" || task.status !== "completed") {
    return;
  }
  const sourceEventId = cleanString(task.source_event_id);
  if (sourceEventId.startsWith("swarm_reducer:")) {
    processSwarmReducerResult(session, task, agentId, now, idGenerator);
  } else if (sourceEventId.startsWith("swarm_reviewer:")) {
    processSwarmReviewerResult(session, task, agentId, now, idGenerator);
  }
}

function replanSwarmFollowUps(
  session: CoworkSession,
  task: CoworkTask,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  if (session.workflow_mode !== "swarm" || task.status !== "completed") {
    return;
  }
  const planStatus = cleanString(session.swarm_plan.status);
  if (["blocked", "failed", "cancelled", "completed"].includes(planStatus)) {
    return;
  }
  const unit = swarmWorkUnitForTask(session, task.id);
  if (!unit || cleanString(unit.status) !== "completed") {
    return;
  }
  if (["follow_up", "revision"].includes(cleanString(unit.kind))) {
    return;
  }
  const result = jsonSafeObject(unit.result);
  const missingWork = stringList(result.missing_work);
  const openQuestions = [
    ...stringList(unit.open_questions),
    ...stringList(result.open_questions),
  ].filter((item, index, items) => items.indexOf(item) === index);
  const signals = [
    ...missingWork.map((description) => ({ description, reason: "missing_work" })),
    ...openQuestions.map((description) => ({
      description,
      reason: missingWork.includes(description) ? "missing_work" : "open_question",
    })),
  ].filter((item, index, items) => {
    return item.description && items.findIndex((candidate) => {
      return candidate.description === item.description && candidate.reason === item.reason;
    }) === index;
  });
  let created = false;
  signals.forEach((signal, index) => {
    created = addFollowUpWorkUnit(session, task, unit, {
      title: `Follow up ${cleanString(unit.title) || cleanString(unit.id)} #${index + 1}`,
      description: signal.description,
      reason: signal.reason,
    }, now, idGenerator) || created;
  });
  if (created) {
    refreshSwarmWorkUnitReadiness(session, now);
  }
}

function replanSwarmFailedSplit(
  session: CoworkSession,
  task: CoworkTask,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  if (session.workflow_mode !== "swarm") {
    return;
  }
  const planStatus = cleanString(session.swarm_plan.status);
  if (["blocked", "failed", "cancelled", "completed"].includes(planStatus)) {
    return;
  }
  const unit = swarmWorkUnitForTask(session, task.id);
  if (!unit || cleanString(unit.status) !== "failed" || !swarmUnitNeedsSplit(unit)) {
    return;
  }
  if (["follow_up", "revision"].includes(cleanString(unit.kind))) {
    return;
  }
  const unitTitle = cleanString(unit.title) || cleanString(unit.id);
  const first = addSplitRevisionWorkUnit(session, unit, {
    title: `Narrow scope for ${unitTitle}`,
    description: `Reduce the scope and define a smaller completion path for failed work unit ${cleanString(unit.id)}: ${cleanString(unit.error) || cleanString(unit.description)}`,
    dependencies: [],
  }, now, idGenerator);
  if (!first) {
    return;
  }
  addSplitRevisionWorkUnit(session, unit, {
    title: `Complete reduced scope for ${unitTitle}`,
    description: `Complete the narrowed version of failed work unit ${cleanString(unit.id)} using the scope defined by ${cleanString(first.id)}.`,
    dependencies: [cleanString(first.source_task_id) || cleanString(first.id)].filter(Boolean),
  }, now, idGenerator);
  refreshSwarmWorkUnitReadiness(session, now);
}

function processSwarmReducerResult(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  const data = jsonSafeObject(task.result_data);
  const answer = cleanString(data.answer) || cleanString(task.result);
  if (answer) {
    session.final_draft = answer;
  }
  const sourceWorkUnitIds = stringList(data.source_work_unit_ids);
  const sourceArtifactRefs = stringList(data.source_artifact_refs).length > 0
    ? stringList(data.source_artifact_refs)
    : stringList(data.artifact_refs);
  const coverageByWorkstream = {
    ...reducerCoverageByWorkstream(session, sourceWorkUnitIds),
    ...jsonSafeObject(data.coverage_by_workstream),
  };
  const confidenceBySection = jsonSafeObject(data.confidence_by_section);
  task.result_data = {
    ...data,
    source_work_unit_ids: sourceWorkUnitIds,
    source_artifact_refs: sourceArtifactRefs,
    coverage_by_workstream: coverageByWorkstream,
    confidence_by_section: confidenceBySection,
  };
  const unit = swarmWorkUnitForTask(session, task.id);
  if (unit) {
    unit.result = {
      answer,
      findings: Array.isArray(data.findings) ? data.findings : [],
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
      risks: Array.isArray(data.risks) ? data.risks : [],
      open_questions: Array.isArray(data.open_questions) ? data.open_questions : [],
      artifact_summary: Array.isArray(data.artifact_summary) ? data.artifact_summary : data.artifact_summary ?? "",
      missing_work: Array.isArray(data.missing_work) ? data.missing_work : stringList(data.missing_work),
      source_work_unit_ids: sourceWorkUnitIds,
      source_artifact_refs: sourceArtifactRefs,
      coverage_by_workstream: coverageByWorkstream,
      confidence_by_section: confidenceBySection,
    };
    unit.source_artifact_refs = sourceArtifactRefs;
    unit.coverage_by_workstream = coverageByWorkstream;
    unit.confidence_by_section = confidenceBySection;
    unit.confidence = task.confidence;
  }
  const missingWork = stringList(data.missing_work);
  const openQuestions = stringList(data.open_questions);
  if (missingWork.length > 0 || openQuestions.length > 0) {
    session.swarm_plan = {
      ...session.swarm_plan,
      status: "active",
      updated_at: now(),
    };
    session.events = [
      ...session.events,
      {
        id: idGenerator("evt"),
        type: "swarm.reducer_missing_work",
        message: "Reducer reported missing work before completion",
        actor_id: task.assigned_agent_id ?? agentId,
        data: {
          task_id: task.id,
          missing_work: missingWork,
          open_questions: openQuestions,
        },
        created_at: now(),
      },
    ];
    return;
  }
  const reviewer = ensureSwarmReviewerTask(session, task, now, idGenerator);
  if (!reviewer) {
    session.swarm_plan = {
      ...session.swarm_plan,
      status: "completed",
      updated_at: now(),
    };
  }
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "synthesis",
      name: "Reducer output accepted",
      actor_id: task.assigned_agent_id ?? agentId,
      status: "completed",
      started_at: now(),
      ended_at: now(),
      input_ref: task.description,
      output_ref: answer,
      summary: "Reducer synthesis stored as the session final draft",
      data: {
        task_id: task.id,
        confidence: task.confidence,
        review_required: Boolean(reviewer),
        source_work_unit_ids: sourceWorkUnitIds,
        source_artifact_refs: sourceArtifactRefs,
        coverage_by_workstream: coverageByWorkstream,
        confidence_by_section: confidenceBySection,
      },
    },
  ];
}

function ensureSwarmReviewerTask(
  session: CoworkSession,
  reducerTask: CoworkTask,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): CoworkTask | null {
  const plan = jsonSafeObject(session.swarm_plan);
  const review = jsonSafeObject(plan.review);
  if (review.required !== true) {
    return null;
  }
  const existing = Object.values(session.tasks).find((task) => cleanString(task.source_event_id).startsWith("swarm_reviewer:"));
  if (existing) {
    return existing;
  }
  const reviewerId = reviewerAgentId(session, cleanString(review.agent_id) || cleanString(plan.reviewer_agent_id));
  const taskId = idGenerator("task");
  const timestamp = now();
  const task: CoworkTask = {
    id: taskId,
    title: "Review swarm synthesis",
    description: [
      "Review the reducer synthesis using this rubric: correctness, completeness, evidence coverage, conflict detection, safety/tool risk, and whether the original goal is satisfied.",
      "Return JSON with verdict pass, needs_revision, or blocked; issues; coverage_issues; uncited_claims; artifact_issues; required_fixes; required_follow_up_units; and confidence.",
      "",
      `Reducer task: ${reducerTask.id}`,
      `Reducer output: ${cleanString(reducerTask.result).slice(0, 1800)}`,
    ].join("\n"),
    assigned_agent_id: reviewerId || null,
    dependencies: [reducerTask.id],
    status: "pending",
    result: null,
    result_data: {},
    confidence: null,
    error: null,
    priority: 0,
    expected_output: "Reviewer verdict JSON with verdict, issues, coverage_issues, uncited_claims, artifact_issues, required_fixes, required_follow_up_units, confidence.",
    review_required: false,
    reviewer_agent_ids: [],
    review_status: "",
    fanout_group_id: "",
    merge_task_id: "",
    source_blueprint_id: "",
    source_event_id: `swarm_reviewer:${cleanString(plan.id) || session.id}`,
    runtime_created: true,
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.tasks[taskId] = task;
  if (reviewerId && session.agents[reviewerId] && ["idle", "done", "blocked"].includes(session.agents[reviewerId].status)) {
    session.agents[reviewerId].status = "waiting";
  }
  const reducerUnit = swarmWorkUnitForTask(session, reducerTask.id);
  const unit = {
    id: taskId,
    title: task.title,
    description: task.description,
    input: { goal: session.goal, source_task_id: task.id, reducer_task_id: reducerTask.id },
    expected_output_schema: { verdict: "string", issues: "array", confidence: "number" },
    completion_criteria: ["Return a valid reviewer verdict."],
    assigned_agent_id: reviewerId || null,
    dependencies: [reducerTask.id],
    status: "pending",
    priority: 0,
    attempts: 0,
    max_attempts: numberValue(jsonSafeObject(plan.budgets).max_retry_attempts) ?? 2,
    tool_allowlist: reviewerId && session.agents[reviewerId] ? session.agents[reviewerId].tools : ["cowork_internal"],
    result: {},
    evidence: [],
    risks: [],
    open_questions: [],
    artifacts: [],
    confidence: null,
    error: null,
    source_task_id: task.id,
    source_event_id: task.source_event_id,
    source_work_unit_ids: reducerUnit ? [cleanString(reducerUnit.id)].filter(Boolean) : [],
    kind: "reviewer",
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.swarm_plan = {
    ...plan,
    status: "reviewing",
    work_units: [...swarmWorkUnits(session), unit],
    updated_at: timestamp,
  };
  refreshSwarmWorkUnitReadiness(session, now);
  session.events = [
    ...session.events,
    {
      id: idGenerator("evt"),
      type: "swarm.reviewer_scheduled",
      message: "Swarm reviewer gate scheduled after reducer synthesis",
      actor_id: "scheduler",
      data: {
        task_id: task.id,
        reducer_task_id: reducerTask.id,
        reviewer_agent_id: reviewerId,
      },
      created_at: timestamp,
    },
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "review",
      name: "Reviewer scheduled",
      actor_id: "scheduler",
      status: "pending",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: reducerTask.id,
      output_ref: task.id,
      summary: "Swarm reviewer gate scheduled after reducer synthesis",
      data: {
        task_id: task.id,
        reducer_task_id: reducerTask.id,
        reviewer_agent_id: reviewerId,
      },
    },
  ];
  return task;
}

function processSwarmReviewerResult(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  const data = jsonSafeObject(task.result_data);
  const verdict = cleanString(data.verdict).toLowerCase();
  if (!["pass", "needs_revision", "blocked"].includes(verdict)) {
    task.status = "failed";
    task.error = "Reviewer verdict was missing or invalid.";
    session.trace_spans = [
      ...session.trace_spans,
      {
        id: idGenerator("span"),
        session_id: session.id,
        kind: "review",
        name: "Reviewer verdict invalid",
        actor_id: task.assigned_agent_id ?? agentId,
        status: "failed",
        started_at: now(),
        ended_at: now(),
        input_ref: task.result ?? "",
        output_ref: "",
        summary: "Reviewer result could not be parsed into a valid verdict",
        data: { task_id: task.id, raw_result: task.result },
        error: task.error,
      },
    ];
    return;
  }
  const coverageIssues = issueList(data.coverage_issues);
  const uncitedClaims = issueList(data.uncited_claims);
  const artifactIssues = issueList(data.artifact_issues);
  const followUpUnits = reviewFollowUpUnits(data.required_follow_up_units);
  const requiredFixes = stringList(data.required_fixes).length > 0 ? stringList(data.required_fixes) : stringList(data.issues);
  task.result_data = {
    ...data,
    review_status: verdict,
    coverage_issues: coverageIssues,
    uncited_claims: uncitedClaims,
    artifact_issues: artifactIssues,
    required_follow_up_units: followUpUnits,
  };
  if (verdict === "pass") {
    session.swarm_plan = {
      ...session.swarm_plan,
      status: "completed",
      updated_at: now(),
    };
  } else if (verdict === "needs_revision") {
    session.swarm_plan = {
      ...session.swarm_plan,
      status: "active",
      updated_at: now(),
    };
    createRevisionWorkUnits(session, task, followUpUnits, requiredFixes, now, idGenerator);
  } else {
    session.stop_reason = "review_blocked";
    session.budget_usage = {
      ...jsonSafeObject(session.budget_usage),
      stop_reason: "review_blocked",
    };
    session.swarm_plan = {
      ...session.swarm_plan,
      status: "blocked",
      updated_at: now(),
    };
    session.events = [
      ...session.events,
      {
        id: idGenerator("evt"),
        type: "scheduler.stop",
        message: "Swarm reviewer blocked completion",
        actor_id: "scheduler",
        data: {
          stop_reason: "review_blocked",
          task_id: task.id,
          issues: Array.isArray(data.issues) ? data.issues : [],
          required_fixes: requiredFixes,
        },
        created_at: now(),
      },
    ];
  }
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "review",
      name: "Reviewer verdict accepted",
      actor_id: task.assigned_agent_id ?? agentId,
      status: verdict === "blocked" ? "blocked" : "completed",
      started_at: now(),
      ended_at: now(),
      input_ref: task.description,
      output_ref: verdict,
      summary: `Reviewer verdict: ${verdict}`,
      data: {
        task_id: task.id,
        verdict,
        issues: Array.isArray(data.issues) ? data.issues : [],
        coverage_issues: coverageIssues,
        uncited_claims: uncitedClaims,
        artifact_issues: artifactIssues,
        required_fixes: requiredFixes,
        required_follow_up_units: followUpUnits,
      },
    },
  ];
  evaluateSwarmCompletion(session, now, idGenerator);
}

function createRevisionWorkUnits(
  session: CoworkSession,
  reviewerTask: CoworkTask,
  followUpUnits: JsonObject[],
  requiredFixes: string[],
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  const createdSignatures = new Set<string>();
  let created = 0;
  for (const item of followUpUnits.slice(0, 4)) {
    const description = cleanString(item.description) || cleanString(item.title) || "Address reviewer follow-up.";
    const signature = description.toLowerCase();
    if (signature) {
      createdSignatures.add(signature);
    }
    addRevisionWorkUnit(session, reviewerTask, {
      title: cleanString(item.title) || `Revision ${created + 1}: ${description.slice(0, 80)}`,
      description,
      sourceWorkUnitIds: stringList(item.source_work_unit_ids),
      sourceArtifactRefs: stringList(item.source_artifact_refs),
      reason: "reviewer_required_follow_up",
    }, now, idGenerator);
    created += 1;
  }
  const remainingFixes = requiredFixes.filter((fix) => !createdSignatures.has(fix.toLowerCase()));
  for (const fix of remainingFixes.slice(0, Math.max(0, 4 - created))) {
    addRevisionWorkUnit(session, reviewerTask, {
      title: `Revision ${created + 1}: ${fix.slice(0, 80)}`,
      description: fix,
      sourceWorkUnitIds: [],
      sourceArtifactRefs: [],
      reason: "reviewer_needs_revision",
    }, now, idGenerator);
    created += 1;
  }
}

function evaluateSwarmCompletion(session: CoworkSession, now: () => string, idGenerator: CoworkIdGenerator): JsonObject[] {
  if (session.workflow_mode !== "swarm") {
    return [];
  }
  const evaluations: JsonObject[] = [
    evaluateSwarmGoalCoverage(session, idGenerator),
    evaluateSwarmEvidenceCoverage(session, idGenerator),
    evaluateSwarmUncitedClaims(session, idGenerator),
    evaluateSwarmWorkstreamCoverage(session, idGenerator),
    evaluateSwarmConflictDetection(session, idGenerator),
    evaluateSwarmArtifactValidation(session, idGenerator),
    evaluateSwarmSafetyPolicy(session, idGenerator),
    evaluateSwarmBudgetState(session, idGenerator),
  ];
  const blocking = evaluations.filter((item) => ["block", "error"].includes(cleanString(item.status)));
  session.runtime_state = {
    ...jsonSafeObject(session.runtime_state),
    swarm_evaluations: evaluations,
  };
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "evaluation",
      name: "Swarm evaluations updated",
      actor_id: "scheduler",
      status: blocking.length > 0 ? "blocked" : "completed",
      started_at: now(),
      ended_at: now(),
      input_ref: "",
      output_ref: "",
      summary: `Swarm evaluations produced ${blocking.length} blocker(s)`,
      data: { evaluations },
    },
  ];
  return evaluations;
}

function evaluateSwarmGoalCoverage(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const baseUnits = swarmWorkUnits(session).filter((unit) => !["reducer", "reviewer"].includes(cleanString(unit.kind)));
  const incomplete = baseUnits.filter((unit) => !["completed", "skipped"].includes(cleanString(unit.status)));
  const reducerDone = Object.values(session.tasks)
    .some((task) => task.status === "completed" && cleanString(task.source_event_id).startsWith("swarm_reducer:"));
  if (incomplete.length > 0) {
    return {
      id: idGenerator("eval"),
      kind: "goal_coverage",
      status: "block",
      summary: `${incomplete.length} required work unit(s) are still unfinished.`,
      blocking_work_unit_ids: incomplete.map((unit) => cleanString(unit.id)).filter(Boolean),
      recommended_actions: ["finish_required_work_units"],
    };
  }
  if (!reducerDone) {
    return {
      id: idGenerator("eval"),
      kind: "goal_coverage",
      status: "block",
      summary: "Reducer synthesis has not completed.",
      recommended_actions: ["run_reducer"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "goal_coverage",
    status: "pass",
    score: 1,
    summary: "Required work units and reducer synthesis are complete.",
  };
}

function evaluateSwarmEvidenceCoverage(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const reducerTask = Object.values(session.tasks).find((task) => {
    return task.status === "completed" && cleanString(task.source_event_id).startsWith("swarm_reducer:");
  });
  const data = reducerTask ? jsonSafeObject(reducerTask.result_data) : {};
  const sourceIds = stringList(data.source_work_unit_ids);
  const completedIds = swarmWorkUnits(session)
    .filter((unit) => !["reducer", "reviewer"].includes(cleanString(unit.kind)) && cleanString(unit.status) === "completed")
    .map((unit) => cleanString(unit.id))
    .filter(Boolean);
  if (completedIds.length > 0 && sourceIds.length === 0) {
    return {
      id: idGenerator("eval"),
      kind: "evidence_coverage",
      status: "warn",
      score: 0.4,
      summary: "Reducer output does not cite source work-unit ids.",
      recommended_actions: ["add_source_work_unit_ids"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "evidence_coverage",
    status: "pass",
    score: 1,
    summary: "Reducer output cites source work units.",
  };
}

function evaluateSwarmUncitedClaims(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const issues = [
    ...uncitedReducerClaims(session),
    ...reviewerUncitedClaims(session),
  ];
  if (issues.length > 0) {
    return {
      id: idGenerator("eval"),
      kind: "uncited_claims",
      status: "warn",
      score: 0.5,
      summary: `${issues.length} reducer claim(s) need clearer source citations.`,
      issues,
      recommended_actions: ["add_source_work_unit_ids", "add_source_artifact_refs"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "uncited_claims",
    status: "pass",
    score: 1,
    summary: "Important reducer claims include source citations.",
  };
}

function reviewerUncitedClaims(session: CoworkSession): unknown[] {
  const reviewerTask = Object.values(session.tasks).find((task) => {
    return cleanString(task.source_event_id).startsWith("swarm_reviewer:");
  });
  return reviewerTask ? issueList(jsonSafeObject(reviewerTask.result_data).uncited_claims).map((item) => {
    if (isJsonObject(item)) {
      return jsonSafeObject(item);
    }
    return { code: "review_issue", summary: cleanString(item) };
  }).filter((item) => cleanString(item.summary)) : [];
}

function uncitedReducerClaims(session: CoworkSession): JsonObject[] {
  const reducerTask = Object.values(session.tasks).find((task) => {
    return task.status === "completed" && cleanString(task.source_event_id).startsWith("swarm_reducer:");
  });
  const data = reducerTask ? jsonSafeObject(reducerTask.result_data) : {};
  if (Object.keys(data).length === 0) {
    return [];
  }
  const topLevelSources = stringList(data.source_work_unit_ids);
  const topLevelArtifacts = [
    ...stringList(data.source_artifact_refs),
    ...stringList(data.artifact_refs),
  ];
  const hasTopLevelCitation = topLevelSources.length > 0 || topLevelArtifacts.length > 0;
  const issues: JsonObject[] = [];
  for (const field of ["findings", "decisions", "risks"]) {
    const values = data[field];
    if (!Array.isArray(values)) {
      continue;
    }
    values.forEach((item, index) => {
      if (isJsonObject(item)) {
        const claim = jsonSafeObject(item);
        const text = cleanString(claim.summary) || cleanString(claim.text) || cleanString(claim.claim) || cleanString(claim.answer);
        const sourceIds = stringList(claim.source_work_unit_ids);
        const artifactRefs = [...stringList(claim.source_artifact_refs), ...stringList(claim.artifact_refs)];
        if (text && sourceIds.length === 0 && artifactRefs.length === 0 && !hasTopLevelCitation) {
          issues.push({ code: "uncited_claim", field, index, summary: text.slice(0, 240) });
        }
      } else {
        const text = cleanString(item);
        if (text && !hasTopLevelCitation) {
          issues.push({ code: "uncited_claim", field, index, summary: text.slice(0, 240) });
        }
      }
    });
  }
  return issues;
}

function evaluateSwarmWorkstreamCoverage(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const completedUnits = swarmWorkUnits(session).filter((unit) => {
    return !["reducer", "reviewer"].includes(cleanString(unit.kind)) && cleanString(unit.status) === "completed";
  });
  const workstreams = [...new Set(completedUnits.map(swarmWorkstream).filter(Boolean))];
  if (workstreams.length === 0) {
    return {
      id: idGenerator("eval"),
      kind: "workstream_coverage",
      status: "pass",
      score: 1,
      summary: "No completed workstreams require reducer coverage yet.",
    };
  }
  const reducerTask = Object.values(session.tasks).find((task) => {
    return task.status === "completed" && cleanString(task.source_event_id).startsWith("swarm_reducer:");
  });
  const data = reducerTask ? jsonSafeObject(reducerTask.result_data) : {};
  const coverage = jsonSafeObject(data.coverage_by_workstream);
  const citedIds = new Set(stringList(data.source_work_unit_ids));
  const citedStreams = new Set<string>();
  for (const unit of completedUnits) {
    const stream = swarmWorkstream(unit);
    const coverageValue = coverage[stream];
    const streamCoverage = typeof coverageValue === "number"
      ? coverageValue
      : cleanString(coverageValue) ? 1 : 0;
    if (citedIds.has(cleanString(unit.id)) || streamCoverage > 0) {
      citedStreams.add(stream);
    }
  }
  const missing = workstreams.filter((stream) => !citedStreams.has(stream)).sort();
  if (missing.length > 0) {
    return {
      id: idGenerator("eval"),
      kind: "workstream_coverage",
      status: "warn",
      score: Math.round((citedStreams.size / Math.max(1, workstreams.length)) * 1000) / 1000,
      summary: `Reducer output does not cover ${missing.length} completed workstream(s).`,
      issues: missing.map((workstream) => ({ code: "missing_workstream_coverage", workstream })),
      recommended_actions: ["add_coverage_by_workstream", "cite_missing_workstreams"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "workstream_coverage",
    status: "pass",
    score: 1,
    summary: "Reducer coverage spans completed workstreams.",
  };
}

function evaluateSwarmConflictDetection(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const conflicts = detectSwarmDisagreements(session);
  if (conflicts.length > 0) {
    return {
      id: idGenerator("eval"),
      kind: "conflict_detection",
      status: "block",
      summary: `${conflicts.length} unresolved conflict signal(s) detected.`,
      issues: conflicts,
      blocking_task_ids: conflicts.map((item) => cleanString(item.task_id)).filter(Boolean),
      recommended_actions: ["resolve_conflicts"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "conflict_detection",
    status: "pass",
    score: 1,
    summary: "No unresolved conflict signals detected.",
  };
}

function detectSwarmDisagreements(session: CoworkSession): JsonObject[] {
  const signals: JsonObject[] = [];
  const claimsByText = new Map<string, Set<string>>();
  for (const task of Object.values(session.tasks)) {
    const data = jsonSafeObject(task.result_data);
    for (const key of ["conflicts", "disagreements"]) {
      for (const text of stringList(data[key])) {
        signals.push({ task_id: task.id, kind: key, text });
      }
    }
    for (const claim of stringList(data.claims)) {
      const key = claim.toLowerCase();
      const authors = claimsByText.get(key) ?? new Set<string>();
      authors.add(cleanString(task.assigned_agent_id));
      claimsByText.set(key, authors);
    }
    if (task.status === "completed" && task.confidence !== null && task.confidence < 0.35) {
      signals.push({ task_id: task.id, kind: "low_confidence", confidence: task.confidence });
    }
  }
  for (const [text, authors] of claimsByText.entries()) {
    if (authors.size > 1 && ["not ", "no ", "cannot", "risk", "conflict"].some((marker) => text.includes(marker))) {
      signals.push({ kind: "claim_conflict", text, authors: [...authors].sort() });
    }
  }
  return signals.slice(0, 20);
}

function evaluateSwarmArtifactValidation(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  if (swarmGoalNeedsArtifact(session) && session.artifacts.length === 0) {
    return {
      id: idGenerator("eval"),
      kind: "artifact_validation",
      status: "block",
      summary: "The goal appears to require an artifact, but no artifact is indexed.",
      recommended_actions: ["produce_or_link_required_artifacts"],
    };
  }
  const reducerRefs = new Set(reducerArtifactRefs(session));
  const missingRefs = swarmRequiredArtifactRefs(session).filter((item) => !reducerRefs.has(item));
  const reviewerIssues = reviewerArtifactIssues(session);
  if (missingRefs.length > 0 || reviewerIssues.length > 0) {
    return {
      id: idGenerator("eval"),
      kind: "artifact_validation",
      status: "warn",
      score: reducerRefs.size > 0 ? 0.6 : 0.4,
      summary: `${missingRefs.length + reviewerIssues.length} artifact citation issue(s) need review.`,
      issues: [
        ...missingRefs.map((artifactRef) => ({ code: "missing_required_artifact_ref", artifact_ref: artifactRef })),
        ...reviewerIssues,
      ],
      recommended_actions: ["add_source_artifact_refs", "resolve_artifact_issues"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "artifact_validation",
    status: "pass",
    score: 1,
    summary: "No missing required artifacts detected.",
  };
}

function swarmGoalNeedsArtifact(session: CoworkSession): boolean {
  const goal = session.goal.toLowerCase();
  return [
    "file",
    "artifact",
    "report",
    "code",
    "implement",
    "edit",
    "write",
    "鏂囨。",
    "鏂囦欢",
    "浠ｇ爜",
    "文档",
    "文件",
    "代码",
  ].some((marker) => goal.includes(marker));
}

function reducerArtifactRefs(session: CoworkSession): string[] {
  const reducerTask = Object.values(session.tasks).find((task) => {
    return task.status === "completed" && cleanString(task.source_event_id).startsWith("swarm_reducer:");
  });
  const data = reducerTask ? jsonSafeObject(reducerTask.result_data) : {};
  const sourceRefs = stringList(data.source_artifact_refs);
  return sourceRefs.length > 0 ? sourceRefs : stringList(data.artifact_refs);
}

function swarmRequiredArtifactRefs(session: CoworkSession): string[] {
  const refs: string[] = [];
  for (const unit of swarmWorkUnits(session)) {
    if (["reducer", "reviewer"].includes(cleanString(unit.kind)) || cleanString(unit.status) !== "completed") {
      continue;
    }
    const artifacts = Array.isArray(unit.artifacts) ? unit.artifacts : [];
    for (const artifact of artifacts) {
      const value = isJsonObject(artifact)
        ? cleanString(jsonSafeObject(artifact).path_or_url)
          || cleanString(jsonSafeObject(artifact).path)
          || cleanString(jsonSafeObject(artifact).url)
        : cleanString(artifact);
      if (value && !refs.includes(value)) {
        refs.push(value);
      }
    }
  }
  return refs;
}

function reviewerArtifactIssues(session: CoworkSession): unknown[] {
  const reviewerTask = Object.values(session.tasks).find((task) => {
    return cleanString(task.source_event_id).startsWith("swarm_reviewer:");
  });
  return reviewerTask ? issueList(jsonSafeObject(reviewerTask.result_data).artifact_issues).map((item) => {
    if (isJsonObject(item)) {
      return jsonSafeObject(item);
    }
    return { code: "review_issue", summary: cleanString(item) };
  }).filter((item) => isJsonObject(item) || cleanString(item)) : [];
}

function evaluateSwarmSafetyPolicy(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const stopReason = cleanString(session.stop_reason);
  if (["autonomy_boundary", "review_blocked"].includes(stopReason)) {
    return {
      id: idGenerator("eval"),
      kind: "safety_policy",
      status: "block",
      summary: `Completion is blocked by ${stopReason}.`,
      recommended_actions: ["resolve_safety_or_review_blocker"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "safety_policy",
    status: "pass",
    score: 1,
    summary: "No safety policy blocker is active.",
  };
}

function evaluateSwarmBudgetState(session: CoworkSession, idGenerator: CoworkIdGenerator): JsonObject {
  const stopReason = cleanString(session.stop_reason);
  if (stopReason.includes("budget_exhausted")) {
    return {
      id: idGenerator("eval"),
      kind: "budget_state",
      status: "block",
      summary: `Completion is blocked by budget state: ${stopReason}.`,
      recommended_actions: ["increase_budget_or_skip_work"],
    };
  }
  return {
    id: idGenerator("eval"),
    kind: "budget_state",
    status: "pass",
    score: 1,
    summary: "No budget blocker is active.",
  };
}

function addRevisionWorkUnit(
  session: CoworkSession,
  reviewerTask: CoworkTask,
  input: { title: string; description: string; sourceWorkUnitIds: string[]; sourceArtifactRefs: string[]; reason: string },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  const leadId = leadAgentId(session);
  const timestamp = now();
  const sourceReviewerUnit = swarmWorkUnitForTask(session, reviewerTask.id);
  const sourceWorkUnitId = input.sourceWorkUnitIds[0] || cleanString(sourceReviewerUnit?.id) || reviewerTask.id;
  const unit = {
    id: idGenerator("wu"),
    title: input.title,
    description: input.description,
    input: {
      goal: session.goal,
      reviewer_task_id: reviewerTask.id,
      source_work_unit_ids: input.sourceWorkUnitIds,
      source_artifact_refs: input.sourceArtifactRefs,
    },
    expected_output_schema: { answer: "string", evidence: "array", risks: "array", artifacts: "array", confidence: "number" },
    completion_criteria: ["Address the reviewer follow-up and return structured evidence."],
    assigned_agent_id: leadId || null,
    dependencies: [reviewerTask.id],
    status: "pending",
    priority: 0,
    attempts: 0,
    max_attempts: numberValue(jsonSafeObject(session.swarm_plan.budgets).max_retry_attempts) ?? 2,
    tool_allowlist: leadId && session.agents[leadId] ? session.agents[leadId].tools : ["cowork_internal"],
    result: {},
    evidence: [],
    risks: [],
    open_questions: [],
    artifacts: [],
    confidence: null,
    error: null,
    source_task_id: "",
    source_event_id: `swarm_revision:${cleanString(session.swarm_plan.id) || session.id}`,
    source_work_unit_id: sourceWorkUnitId,
    kind: "revision",
    reason: input.reason,
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.swarm_plan = {
    ...session.swarm_plan,
    work_units: [...swarmWorkUnits(session), unit],
    updated_at: timestamp,
  };
  session.events = [
    ...session.events,
    {
      id: idGenerator("evt"),
      type: "swarm.work_unit_added",
      message: `Added revision work unit '${unit.title}'`,
      actor_id: "scheduler",
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason: input.reason,
        kind: "revision",
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
      name: "Work unit replanned",
      actor_id: "scheduler",
      status: "pending",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: reviewerTask.id,
      output_ref: cleanString(unit.id),
      summary: `Added replanned work unit '${unit.title}'`,
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason: input.reason,
        kind: "revision",
      },
    },
  ];
}

function addFollowUpWorkUnit(
  session: CoworkSession,
  sourceTask: CoworkTask,
  sourceUnit: JsonObject,
  input: { title: string; description: string; reason: string },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): boolean {
  const sourceWorkUnitId = cleanString(sourceUnit.id);
  const description = cleanString(input.description);
  const reason = cleanString(input.reason);
  if (!description || swarmWorkUnits(session).some((unit) => {
    return cleanString(unit.kind) === "follow_up"
      && cleanString(unit.source_work_unit_id) === sourceWorkUnitId
      && cleanString(unit.description) === description
      && cleanString(unit.reason) === reason;
  })) {
    return false;
  }
  const timestamp = now();
  const leadId = leadAgentId(session);
  const assignedAgentId = cleanString(sourceUnit.assigned_agent_id);
  const ownerId = assignedAgentId && session.agents[assignedAgentId] ? assignedAgentId : leadId;
  const taskId = idGenerator("task");
  const sourceEventId = `swarm_replan:${sourceWorkUnitId || reason || taskId}`;
  session.tasks[taskId] = {
    id: taskId,
    title: input.title,
    description,
    assigned_agent_id: ownerId || null,
    dependencies: [sourceTask.id].filter((dependency) => Boolean(session.tasks[dependency])),
    status: "pending",
    result: null,
    result_data: {},
    confidence: null,
    error: null,
    priority: numberValue(sourceUnit.priority) ?? 0,
    expected_output: "Structured swarm follow-up result with answer, evidence, risks, artifacts, confidence, and open_questions.",
    review_required: false,
    reviewer_agent_ids: [],
    review_status: "",
    fanout_group_id: "",
    merge_task_id: "",
    source_blueprint_id: "",
    source_event_id: sourceEventId,
    runtime_created: true,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const unit = {
    id: idGenerator("wu"),
    title: input.title,
    description,
    input: { source_work_unit_id: sourceWorkUnitId, reason },
    expected_output_schema: { answer: "string", evidence: "array", risks: "array", artifacts: "array", confidence: "number" },
    completion_criteria: ["Complete the swarm follow-up and return structured evidence."],
    assigned_agent_id: ownerId || null,
    dependencies: [sourceTask.id],
    status: "pending",
    priority: numberValue(sourceUnit.priority) ?? 0,
    attempts: 0,
    max_attempts: numberValue(sourceUnit.max_attempts) ?? numberValue(jsonSafeObject(session.swarm_plan.budgets).max_retry_attempts) ?? 2,
    tool_allowlist: stringList(sourceUnit.tool_allowlist).length > 0 ? stringList(sourceUnit.tool_allowlist) : ["cowork_internal"],
    result: {},
    evidence: [],
    risks: [],
    open_questions: [],
    artifacts: [],
    confidence: null,
    error: null,
    source_task_id: taskId,
    source_event_id: sourceEventId,
    source_work_unit_id: sourceWorkUnitId,
    kind: "follow_up",
    reason,
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.swarm_plan = {
    ...session.swarm_plan,
    work_units: [...swarmWorkUnits(session), unit],
    updated_at: timestamp,
  };
  session.events = [
    ...session.events,
    {
      id: idGenerator("evt"),
      type: "swarm.work_unit_added",
      message: `Added follow-up work unit '${unit.title}'`,
      actor_id: "scheduler",
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason,
        kind: "follow_up",
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
      name: "Work unit replanned",
      actor_id: "scheduler",
      status: "pending",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: sourceTask.id,
      output_ref: cleanString(unit.id),
      summary: `Added replanned work unit '${unit.title}'`,
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason,
        kind: "follow_up",
      },
    },
  ];
  return true;
}

function addSplitRevisionWorkUnit(
  session: CoworkSession,
  sourceUnit: JsonObject,
  input: { title: string; description: string; dependencies: string[] },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): JsonObject | null {
  const sourceWorkUnitId = cleanString(sourceUnit.id);
  const reason = "split_failed_or_broad_unit";
  const description = cleanString(input.description);
  if (!description || swarmWorkUnits(session).some((unit) => {
    return cleanString(unit.kind) === "revision"
      && cleanString(unit.source_work_unit_id) === sourceWorkUnitId
      && cleanString(unit.reason) === reason
      && cleanString(unit.title) === input.title;
  })) {
    return null;
  }
  const timestamp = now();
  const leadId = leadAgentId(session);
  const assignedAgentId = cleanString(sourceUnit.assigned_agent_id);
  const ownerId = assignedAgentId && session.agents[assignedAgentId] ? assignedAgentId : leadId;
  const taskId = idGenerator("task");
  const dependencies = input.dependencies.filter((dependency) => Boolean(session.tasks[dependency]));
  const sourceEventId = `swarm_replan:${sourceWorkUnitId || reason || taskId}`;
  session.tasks[taskId] = {
    id: taskId,
    title: input.title,
    description,
    assigned_agent_id: ownerId || null,
    dependencies,
    status: "pending",
    result: null,
    result_data: {},
    confidence: null,
    error: null,
    priority: numberValue(sourceUnit.priority) ?? 0,
    expected_output: "Structured swarm follow-up result with answer, evidence, risks, artifacts, confidence, and open_questions.",
    review_required: false,
    reviewer_agent_ids: [],
    review_status: "",
    fanout_group_id: "",
    merge_task_id: "",
    source_blueprint_id: "",
    source_event_id: sourceEventId,
    runtime_created: true,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const unit = {
    id: idGenerator("wu"),
    title: input.title,
    description,
    input: { source_work_unit_id: sourceWorkUnitId, reason },
    expected_output_schema: { answer: "string", evidence: "array", risks: "array", artifacts: "array", confidence: "number" },
    completion_criteria: ["Complete the narrowed swarm revision and return structured evidence."],
    assigned_agent_id: ownerId || null,
    dependencies,
    status: "pending",
    priority: numberValue(sourceUnit.priority) ?? 0,
    attempts: 0,
    max_attempts: numberValue(sourceUnit.max_attempts) ?? numberValue(jsonSafeObject(session.swarm_plan.budgets).max_retry_attempts) ?? 2,
    tool_allowlist: stringList(sourceUnit.tool_allowlist).length > 0 ? stringList(sourceUnit.tool_allowlist) : ["cowork_internal"],
    result: {},
    evidence: [],
    risks: [],
    open_questions: [],
    artifacts: [],
    confidence: null,
    error: null,
    source_task_id: taskId,
    source_event_id: sourceEventId,
    source_work_unit_id: sourceWorkUnitId,
    kind: "revision",
    reason,
    created_at: timestamp,
    updated_at: timestamp,
  };
  session.swarm_plan = {
    ...session.swarm_plan,
    work_units: [...swarmWorkUnits(session), unit],
    updated_at: timestamp,
  };
  session.events = [
    ...session.events,
    {
      id: idGenerator("evt"),
      type: "swarm.work_unit_added",
      message: `Added revision work unit '${unit.title}'`,
      actor_id: "scheduler",
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason,
        kind: "revision",
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
      name: "Work unit replanned",
      actor_id: "scheduler",
      status: "pending",
      started_at: timestamp,
      ended_at: timestamp,
      input_ref: sourceWorkUnitId,
      output_ref: cleanString(unit.id),
      summary: `Added replanned work unit '${unit.title}'`,
      data: {
        work_unit_id: unit.id,
        source_work_unit_id: sourceWorkUnitId,
        reason,
        kind: "revision",
      },
    },
  ];
  return unit;
}

function issueList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.map((item) => isJsonObject(item) ? jsonSafeObject(item) : cleanString(item)).filter((item) => {
      return isJsonObject(item) || cleanString(item);
    });
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function reviewFollowUpUnits(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map((item) => {
    const raw = jsonSafeObject(item);
    const description = cleanString(raw.description) || cleanString(raw.title);
    return {
      title: cleanString(raw.title) || description,
      description,
      source_work_unit_ids: stringList(raw.source_work_unit_ids),
      source_artifact_refs: stringList(raw.source_artifact_refs),
    };
  }).filter((item) => cleanString(item.title) || cleanString(item.description));
}

function reducerCoverageByWorkstream(session: CoworkSession, sourceWorkUnitIds: string[]): JsonObject {
  const selected = new Set(sourceWorkUnitIds);
  const coverage: JsonObject = {};
  for (const unit of swarmWorkUnits(session)) {
    const unitId = cleanString(unit.id);
    if (selected.size > 0 && !selected.has(unitId)) {
      continue;
    }
    if (!["completed", "skipped", "failed"].includes(cleanString(unit.status))) {
      continue;
    }
    const workstream = swarmWorkstream(unit);
    const current = jsonSafeObject(coverage[workstream]);
    coverage[workstream] = {
      ...current,
      work_unit_ids: [...stringList(current.work_unit_ids), unitId].filter(Boolean),
      completed: (numberValue(current.completed) ?? 0) + (cleanString(unit.status) === "completed" ? 1 : 0),
      failed: (numberValue(current.failed) ?? 0) + (cleanString(unit.status) === "failed" ? 1 : 0),
      skipped: (numberValue(current.skipped) ?? 0) + (cleanString(unit.status) === "skipped" ? 1 : 0),
    };
  }
  return coverage;
}

function reviewerAgentId(session: CoworkSession, explicit: string): string {
  if (explicit && session.agents[explicit]) {
    return explicit;
  }
  const reviewer = Object.values(session.agents).find((agent) => {
    const haystack = `${agent.id} ${agent.name} ${agent.role} ${agent.responsibilities.join(" ")}`.toLowerCase();
    return haystack.includes("review") || haystack.includes("verify") || haystack.includes("quality");
  });
  return reviewer?.id ?? leadAgentId(session);
}

function leadAgentId(session: CoworkSession): string {
  for (const candidate of ["coordinator", "lead", "team_lead", "team-lead"]) {
    if (session.agents[candidate]) {
      return candidate;
    }
  }
  return Object.keys(session.agents)[0] ?? "";
}

function swarmWorkUnitForTask(session: CoworkSession, taskId: string): JsonObject | null {
  const units = Array.isArray(session.swarm_plan.work_units) ? session.swarm_plan.work_units : [];
  return units.find((unit) => {
    if (!isJsonObject(unit)) {
      return false;
    }
    return cleanString(unit.source_task_id) === taskId
      || cleanString(unit.task_id) === taskId
      || cleanString(unit.id) === taskId;
  }) as JsonObject | undefined ?? null;
}

function swarmWorkUnitDependenciesMet(session: CoworkSession, unit: JsonObject): boolean {
  const units = Array.isArray(session.swarm_plan.work_units)
    ? session.swarm_plan.work_units.filter(isJsonObject).map(jsonSafeObject)
    : [];
  const completed = new Set([
    ...units
      .filter((candidate) => ["completed", "skipped"].includes(cleanString(candidate.status)))
      .map((candidate) => cleanString(candidate.id))
      .filter(Boolean),
    ...Object.values(session.tasks)
      .filter((candidate) => ["completed", "skipped"].includes(candidate.status))
      .map((candidate) => candidate.id),
  ]);
  return stringList(unit.dependencies).every((dependency) => completed.has(dependency));
}

function swarmUnitNeedsSplit(unit: JsonObject): boolean {
  const attempts = numberValue(unit.attempts) ?? 0;
  const maxAttempts = numberValue(unit.max_attempts) ?? 1;
  const text = `${cleanString(unit.title)} ${cleanString(unit.description)} ${cleanString(unit.error)}`.toLowerCase();
  return attempts >= maxAttempts || ["too broad", "broad scope", "scope too large", "split", "too large"].some((marker) => text.includes(marker));
}

function refreshSwarmWorkUnitReadiness(session: CoworkSession, now: () => string): void {
  const units = Array.isArray(session.swarm_plan.work_units)
    ? session.swarm_plan.work_units.filter(isJsonObject).map(jsonSafeObject)
    : [];
  let changed = false;
  for (const unit of units) {
    if ((cleanString(unit.status) || "pending") !== "pending" || !swarmWorkUnitDependenciesMet(session, unit)) {
      continue;
    }
    unit.status = "ready";
    unit.updated_at = now();
    unit.readiness_reason = {
      completed_dependencies: stringList(unit.dependencies).sort(),
      priority: numberValue(unit.priority) ?? 0,
    };
    changed = true;
  }
  if (changed) {
    session.swarm_plan = {
      ...session.swarm_plan,
      work_units: units,
      updated_at: now(),
    };
  }
}

function selectTaskForAgent(session: CoworkSession, agentId: string): CoworkTask | undefined {
  const agent = session.agents[agentId];
  if (agent?.current_task_id) {
    const current = session.tasks[agent.current_task_id];
    if (current && ["pending", "in_progress"].includes(current.status) && (!current.assigned_agent_id || current.assigned_agent_id === agentId)) {
      return current;
    }
  }
  const completed = new Set(Object.values(session.tasks)
    .filter((task) => ["completed", "skipped"].includes(task.status))
    .map((task) => task.id));
  return Object.values(session.tasks)
    .filter((task) => task.status === "pending")
    .filter((task) => !task.assigned_agent_id || task.assigned_agent_id === agentId)
    .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
    .sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))[0];
}

function selectDirectTaskForAgent(session: CoworkSession, agentId: string): CoworkTask | undefined {
  const agent = session.agents[agentId];
  if (agent?.current_task_id) {
    const current = session.tasks[agent.current_task_id];
    if (current && ["pending", "in_progress"].includes(current.status) && current.assigned_agent_id === agentId) {
      return current;
    }
  }
  const completed = completedTaskIds(session);
  return Object.values(session.tasks)
    .filter((task) => task.status === "pending")
    .filter((task) => task.assigned_agent_id === agentId)
    .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
    .sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))[0];
}

function unassignedReadyTasks(session: CoworkSession): CoworkTask[] {
  const completed = completedTaskIds(session);
  return Object.values(session.tasks)
    .filter((task) => task.status === "pending")
    .filter((task) => !task.assigned_agent_id)
    .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
    .sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function completedTaskIds(session: CoworkSession): Set<string> {
  return new Set(Object.values(session.tasks)
    .filter((task) => ["completed", "skipped"].includes(task.status))
    .map((task) => task.id));
}

function isSelectableAgentStatus(agent: CoworkAgent): boolean {
  return !["done", "failed", "retired"].includes(agent.status)
    && cleanString(agent.lifecycle_status || "active") !== "retired";
}

function parseAgentProgress(content: string): CoworkAgentProgress {
  const text = content.trim();
  const parsed = parseProgressObject(text);
  if (!parsed) {
    return {
      status: "idle",
      action: "continue",
      target_agent_id: "",
      task_title: "",
      action_reason: "",
      public_note: text || "Cowork round completed.",
      private_note: text || "Cowork round completed.",
      completed_task_ids: [],
      completed_task_results: [],
      new_task_suggestions: [],
    };
  }
  const status = normalizeProgressStatus(parsed.status);
  const action = normalizeProgressAction(parsed.action, status);
  const publicNote = cleanString(parsed.public_note) || cleanString(parsed.note);
  return {
    status,
    action,
    target_agent_id: cleanString(parsed.target_agent_id) || cleanString(parsed.assigned_agent_id),
    task_title: cleanString(parsed.task_title) || cleanString(parsed.title),
    action_reason: cleanString(parsed.reason) || cleanString(parsed.action_reason),
    public_note: publicNote,
    private_note: cleanString(parsed.private_note) || publicNote || text,
    completed_task_ids: stringList(parsed.completed_task_ids),
    completed_task_results: objectList(parsed.completed_task_results),
    new_task_suggestions: objectList(parsed.new_task_suggestions),
  };
}

function parseProgressObject(text: string): JsonObject | null {
  for (const candidate of [text, extractJsonObject(text)]) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isJsonObject(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
  if (fenced) {
    return fenced[1];
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function buildAgentSystemPrompt(session: CoworkSession, agent: CoworkAgent): string {
  return [
    `You are ${agent.name}, role: ${agent.role || "Cowork agent"}.`,
    `Session goal: ${session.goal}`,
    `Agent goal: ${agent.goal || session.goal}`,
    "Return a JSON object with status, action, public_note, private_note, completed_task_ids, completed_task_results, and new_task_suggestions.",
  ].join("\n");
}

function buildAgentWorkPrompt(session: CoworkSession, agent: CoworkAgent, task: CoworkTask | undefined, unread: JsonObject[]): string {
  const taskBlock = task
    ? [`Current task: ${task.title}`, `Task description: ${task.description}`, `Expected output: ${task.expected_output || "(not specified)"}`].join("\n")
    : "No assigned task is ready. Respond to inbox context if useful.";
  const inbox = unread.length > 0
    ? unread.map((message) => `- ${stringValue(message.sender_id)}: ${stringValue(message.content)}`).join("\n")
    : "(none)";
  return [
    taskBlock,
    "",
    `Current focus: ${session.current_focus_task || session.goal}`,
    `Your private summary: ${agent.private_summary || "(empty)"}`,
    "",
    "Unread messages:",
    inbox,
  ].join("\n");
}

function appendAgentMessage(session: CoworkSession, agentId: string, content: string, idGenerator: CoworkIdGenerator, now: () => string): void {
  const thread = Object.values(session.threads)[0];
  if (!thread) {
    return;
  }
  const messageId = idGenerator("msg");
  const message = {
    id: messageId,
    thread_id: stringValue(thread.id),
    sender_id: agentId,
    recipient_ids: ["user"],
    content,
    visibility: "public",
    kind: "message",
    created_at: now(),
    read_by: [agentId],
    envelope_id: null,
  };
  session.messages[messageId] = message;
  thread.message_ids = [...stringList(thread.message_ids), messageId];
  thread.updated_at = now();
  thread.last_message_at = now();
}

function normalizeProgressStatus(value: unknown): string {
  const status = cleanString(value).toLowerCase();
  if (status === "needs_review") {
    return "waiting";
  }
  return ["idle", "waiting", "blocked", "done", "failed"].includes(status) ? status : "idle";
}

function normalizeProgressAction(value: unknown, status: string): string {
  const action = cleanString(value).toLowerCase();
  if (action === "delegate" || action === "handoff_to") {
    return "handoff";
  }
  if (action === "answer_user" || action === "respond") {
    return "respond_user";
  }
  if (["continue", "handoff", "review", "complete", "respond_user", "block"].includes(action)) {
    return action;
  }
  return status === "blocked" ? "block" : "continue";
}

function appendSummary(current: string, note: string): string {
  const cleanNote = cleanString(note);
  if (!cleanNote) {
    return current;
  }
  return [current, cleanNote].map(cleanString).filter(Boolean).join("\n\n").slice(-4000);
}

function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject).map(jsonSafeObject) : [];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function jsonSafeObject(value: unknown): JsonObject {
  return isJsonObject(value) ? { ...value } : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
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
