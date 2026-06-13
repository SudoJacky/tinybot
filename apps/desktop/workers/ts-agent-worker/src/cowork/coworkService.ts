import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { normalizeArchitectureName } from "./coworkArchitecture.ts";
import { normalizeBlueprint, previewBlueprint } from "./coworkBlueprint.ts";
import { CoworkMailbox, type CoworkEnvelope, type CoworkMailboxMessage } from "./coworkMailbox.ts";
import { normalizeCoworkSession } from "./coworkSerde.ts";
import { buildSwarmSchedulerQueues, coworkSessionSnapshot } from "./coworkSnapshot.ts";
import type { CoworkAgent, CoworkBranch, CoworkEvent, CoworkSession, CoworkTask } from "./coworkTypes.ts";

const DEFAULT_BRANCH_ID = "default";
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
const MAX_EVENT_COUNT = 500;
const MAX_TRACE_SPAN_COUNT = 1000;
const MAX_AGENT_STEP_COUNT = 1000;

export const DEFAULT_COWORK_AGENT_TOOLS = [
  "cowork_internal",
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
  "delete_file",
];

export interface CoworkServiceStore {
  listSnapshots(traceId: string): Promise<CoworkSession[]>;
  readSnapshot(sessionId: string, traceId: string): Promise<CoworkSession | null>;
  writeSnapshot(session: CoworkSession, traceId: string): Promise<CoworkSession>;
  deleteSession(sessionId: string, traceId: string): Promise<boolean>;
  readEvents?(sessionId: string, traceId: string): Promise<CoworkEvent[]>;
  readTraceSpans?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  readAgentSteps?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  readToolObservations?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  readBrowserObservations?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  readObservationDetails?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  readSensitiveArtifacts?(sessionId: string, traceId: string): Promise<JsonObject[]>;
  ensureSessionWorkspace?(sessionId: string, traceId: string): Promise<string>;
}

export type CoworkIdGenerator = (prefix: string) => string;

export type CoworkServiceOptions = {
  store: CoworkServiceStore;
  now?: () => string;
  idGenerator?: CoworkIdGenerator;
};

export type CoworkServiceListener = (session: CoworkSession, event: CoworkEvent) => void;

export type CoworkAgentInput = JsonObject & {
  id?: string;
  name?: string;
  role?: string;
  goal?: string;
  responsibilities?: unknown;
  tools?: unknown;
  subscriptions?: unknown;
  communication_policy?: string;
  context_policy?: string;
};

export type CoworkTaskInput = JsonObject & {
  id?: string;
  title?: string;
  description?: string;
  assigned_agent_id?: string | null;
  dependencies?: unknown;
};

export type CreateCoworkSessionRequest = {
  traceId?: string;
  goal: string;
  title?: string;
  agents?: CoworkAgentInput[];
  tasks?: CoworkTaskInput[];
  workflowMode?: string;
  budgets?: JsonObject;
  blueprint?: JsonObject;
  blueprintDiagnostics?: JsonObject[];
  runtimeState?: JsonObject;
};

export type CreateCoworkSessionFromBlueprintRequest = {
  traceId?: string;
  blueprint: unknown;
  runtimeState?: JsonObject;
};

export type CreateCoworkSessionFromBlueprintResult = {
  session: CoworkSession | null;
  diagnostics: JsonObject[];
};

export type SendCoworkMessageRequest = {
  traceId?: string;
  sessionId: string;
  senderId: string;
  recipientIds: string[];
  content: string;
  threadId?: string;
  topic?: string;
  eventType?: string;
  wakeRecipients?: boolean;
};

export type SteerCoworkSwarmRequest = {
  traceId?: string;
  sessionId: string;
  instruction: string;
};

export type AddCoworkTaskRequest = {
  traceId?: string;
  sessionId: string;
  title: string;
  description?: string;
  assignedAgentId?: string | null;
  dependencies?: string[];
  priority?: number;
  expectedOutput?: string;
  reviewRequired?: boolean;
  reviewerAgentIds?: string[];
  fanoutGroupId?: string;
  mergeTaskId?: string;
  sourceBlueprintId?: string;
  sourceEventId?: string;
  runtimeCreated?: boolean;
};

export type AssignCoworkTaskRequest = {
  traceId?: string;
  sessionId: string;
  taskId: string;
  agentId: string;
};

export type RetryCoworkTaskRequest = {
  traceId?: string;
  sessionId: string;
  taskId: string;
};

export type CoworkWorkUnitActionRequest = CoworkSessionControlRequest & {
  workUnitId: string;
  reason?: string;
};

export type RequestCoworkTaskReviewRequest = {
  traceId?: string;
  sessionId: string;
  taskId: string;
  reviewerAgentId?: string | null;
};

export type CoworkSessionControlRequest = {
  traceId?: string;
  sessionId: string;
};

export type CoworkReadOnlyRequest = CoworkSessionControlRequest;

export type CoworkAgentActivityRequest = CoworkSessionControlRequest & {
  agentId: string;
  limit?: number;
};

export type CoworkObservationDetailRequest = CoworkSessionControlRequest & {
  detailId: string;
  requesterAgentId?: string | null;
};

export type CoworkEmergencyStopRequest = CoworkSessionControlRequest & {
  reason?: string;
  actorId?: string;
};

export type UpdateCoworkBudgetRequest = CoworkSessionControlRequest & {
  budgets: JsonObject;
};

export type DeliverCoworkEnvelopeRequest = CoworkSessionControlRequest & {
  envelope: CoworkEnvelope;
};

export type MarkCoworkMailboxReadRequest = CoworkSessionControlRequest & {
  agentId: string;
};

export type SelectCoworkBranchRequest = CoworkSessionControlRequest & {
  branchId: string;
};

export type DeriveCoworkBranchRequest = CoworkSessionControlRequest & {
  sourceBranchId?: string | null;
  targetArchitecture?: string;
  reason?: string;
  title?: string;
  inheritedContextSummary?: string;
};

export type SelectCoworkFinalResultRequest = CoworkSessionControlRequest & {
  branchId: string;
  resultId?: string | null;
};

export type MergeCoworkBranchResultsRequest = CoworkSessionControlRequest & {
  branchIds: string[];
  summary?: string;
};

export class CoworkService {
  private readonly store: CoworkServiceStore;
  private readonly now: () => string;
  private readonly idGenerator: CoworkIdGenerator;
  private readonly listeners = new Set<CoworkServiceListener>();

  constructor(options: CoworkServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${cryptoRandomSuffix()}`);
  }

  addListener(listener: CoworkServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listSessions(traceId = "", options: { includeCompleted?: boolean } = {}): Promise<CoworkSession[]> {
    const sessions = await Promise.all((await this.store.listSnapshots(traceId))
      .map((session) => this.recoverLoadedSession(session, traceId)));
    return sessions
      .filter((session) => options.includeCompleted === true || session.status !== "completed")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async getSession(sessionId: string, traceId = ""): Promise<CoworkSession | null> {
    return this.loadSession(sessionId, traceId);
  }

  async deleteSession(sessionId: string, traceId = ""): Promise<boolean> {
    return this.store.deleteSession(sessionId, traceId);
  }

  async exportBlueprint(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const base = jsonSafeObject(session.blueprint);
    const blueprint = {
      schema_version: "cowork.blueprint.v1",
      goal: session.goal,
      title: session.title || "Cowork Session",
      workflow_mode: normalizeArchitectureName(session.workflow_mode || stringValue(base.workflow_mode)),
      lead_agent_id: stringValue(base.lead_agent_id) || leadAgentId(session.agents),
      agents: Object.values(session.agents).map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        goal: agent.goal,
        responsibilities: [...agent.responsibilities],
        tools: [...agent.tools],
        subscriptions: [...agent.subscriptions],
        communication_policy: agent.communication_policy,
        context_policy: agent.context_policy,
        parent_agent_id: agent.parent_agent_id,
        team_id: agent.team_id,
      })),
      tasks: Object.values(session.tasks).map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        assigned_agent_id: task.assigned_agent_id,
        dependencies: [...task.dependencies],
        priority: task.priority,
        expected_output: task.expected_output,
        review_required: task.review_required,
        reviewer_agent_ids: [...task.reviewer_agent_ids],
        fanout_group_id: task.fanout_group_id,
        merge_task_id: task.merge_task_id,
      })),
      routes: jsonObjectArray(base.routes),
      review: jsonSafeObject(base.review),
      budgets: Object.keys(session.budget_limits).length ? jsonSafeObject(session.budget_limits) : jsonSafeObject(base.budgets),
      layout: jsonSafeObject(base.layout),
      metadata: {
        ...jsonSafeObject(base.metadata),
        exported_from_session_id: session.id,
        runtime_fields_excluded: true,
      },
    };
    return normalizeBlueprint(blueprint);
  }

  async getGraph(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return jsonSafeObject(snapshot.graph);
  }

  async getTrace(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return {
      trace: arrayValue(snapshot.trace),
      trace_spans: arrayValue(snapshot.trace_spans),
      agent_steps: arrayValue(snapshot.agent_steps),
      scheduler_decisions: session.scheduler_decisions.slice(-80).map(jsonSafeObject),
      run_metrics: arrayValue(snapshot.run_metrics),
    };
  }

  async getSummary(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return {
      session_id: session.id,
      title: session.title,
      goal: session.goal,
      status: session.status,
      workflow_mode: session.workflow_mode,
      architecture: stringValue(snapshot.architecture),
      current_branch_id: session.current_branch_id,
      current_focus_task: session.current_focus_task,
      shared_summary: session.shared_summary,
      final_draft: session.final_draft,
      completion_decision: jsonSafeObject(session.completion_decision),
      session_final_result: session.session_final_result ? jsonSafeObject(session.session_final_result) : {},
      budget_state: jsonSafeObject(snapshot.budget_state),
      stop_reason: session.stop_reason,
      counts: {
        agents: Object.keys(session.agents).length,
        tasks: Object.keys(session.tasks).length,
        messages: Object.keys(session.messages).length,
        mailbox: Object.keys(session.mailbox).length,
        artifacts: arrayValue(snapshot.artifact_index).length,
        branches: Object.keys(session.branches).length,
      },
      updated_at: session.updated_at,
    };
  }

  async formatSummary(request: CoworkReadOnlyRequest): Promise<string> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    if (cleanString(session.final_draft)) {
      return session.final_draft;
    }
    const completed = Object.values(session.tasks).filter((task) => task.status === "completed");
    const lines = [
      `## ${session.title} (${session.id})`,
      `Status: ${session.status}`,
      "",
      "### Completed Work",
    ];
    if (completed.length > 0) {
      for (const task of completed) {
        lines.push(`- ${task.title}: ${cleanString(task.result) || "Completed"}`);
      }
    } else {
      lines.push("- No completed tasks yet.");
    }
    lines.push("", "### Agent Notes");
    for (const agent of Object.values(session.agents)) {
      const note = cleanString(agent.private_summary) ? agent.private_summary.slice(-500) : "(no note yet)";
      lines.push(`- ${agent.name}: ${note}`);
    }
    return lines.join("\n");
  }

  async getTaskDag(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return jsonSafeObject(snapshot.task_dag);
  }

  async getArtifacts(request: CoworkReadOnlyRequest): Promise<JsonObject[]> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return arrayValue(snapshot.artifact_index).map(jsonSafeObject);
  }

  async getOrganization(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const snapshot = coworkSessionSnapshot(session);
    return jsonSafeObject(snapshot.organization_projection);
  }

  async getQueues(request: CoworkReadOnlyRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    return buildSwarmSchedulerQueues(session);
  }

  async getAgentActivity(request: CoworkAgentActivityRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const agentId = slug(request.agentId, "agent");
    const limit = clampLimit(request.limit, 20);
    const agent = session.agents[agentId];
    if (!agent) {
      return {
        available: false,
        session_id: session.id,
        agent_id: agentId,
        error: "agent not found",
        updated_at: session.updated_at,
        recent_steps: [],
        linked_tasks: [],
        linked_messages: [],
        mailbox_records: [],
        tool_observations: [],
        browser_observations: [],
        artifacts: [],
      };
    }

    const currentTask = agentCurrentTask(session, agentId);
    const steps = session.agent_steps
      .map(jsonSafeObject)
      .filter((step) => stringValue(step.agent_id) === agentId)
      .slice(-limit);
    const linkedTaskIds = new Set<string>();
    const linkedMessageIds = new Set<string>();
    const linkedArtifactRefs: string[] = [];
    for (const step of steps) {
      const taskId = stringValue(step.task_id);
      if (taskId) {
        linkedTaskIds.add(taskId);
      }
      for (const value of arrayValue(step.linked_task_ids).map(stringValue).filter(Boolean)) {
        linkedTaskIds.add(value);
      }
      for (const value of arrayValue(step.linked_message_ids).map(stringValue).filter(Boolean)) {
        linkedMessageIds.add(value);
      }
      linkedArtifactRefs.push(...arrayValue(step.linked_artifact_refs).map(stringValue).filter(Boolean));
    }
    if (currentTask) {
      linkedTaskIds.add(stringValue(currentTask.id));
    }
    const mailboxRecords = Object.values(session.mailbox)
      .map(jsonSafeObject)
      .filter((record) => arrayValue(record.recipient_ids).map(stringValue).includes(agentId) || stringValue(record.sender_id) === agentId)
      .slice(-limit);
    const messages = Object.values(session.messages)
      .map(jsonSafeObject)
      .filter((message) => linkedMessageIds.has(stringValue(message.id))
        || stringValue(message.sender_id) === agentId
        || arrayValue(message.recipient_ids).map(stringValue).includes(agentId))
      .slice(-limit);
    const artifactIndex = arrayValue(coworkSessionSnapshot(session).artifact_index).map(jsonSafeObject);
    const artifacts = artifactIndex
      .filter((artifact) => linkedArtifactRefs.includes(stringValue(artifact.path_or_url)) || linkedArtifactRefs.includes(stringValue(artifact.id)))
      .slice(-limit);

    return {
      available: true,
      session_id: session.id,
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        goal: agent.goal,
        status: agent.status,
        current_task_id: agent.current_task_id,
        current_task_title: agent.current_task_title || stringValue(currentTask?.title),
        rounds: agent.rounds,
        inbox_count: agent.inbox.length,
        pending_reply_count: mailboxRecords.filter((record) => record.requires_reply === true && ["delivered", "read"].includes(stringValue(record.status))).length,
        last_active_at: agent.last_active_at,
      },
      current_task: currentTask,
      recent_steps: steps,
      linked_tasks: [...linkedTaskIds]
        .map((taskId) => session.tasks[taskId])
        .filter((task): task is CoworkTask => Boolean(task))
        .map(taskActivityPayload)
        .slice(0, limit),
      linked_messages: messages,
      mailbox_records: mailboxRecords,
      tool_observations: steps.flatMap((step) => arrayValue(step.tool_observations).map(jsonSafeObject)).slice(-limit),
      browser_observations: steps.flatMap((step) => arrayValue(step.browser_observations).map(jsonSafeObject)).slice(-limit),
      artifacts,
      counts: {
        recent_steps: steps.length,
        linked_tasks: linkedTaskIds.size,
        linked_messages: messages.length,
        mailbox_records: mailboxRecords.length,
        artifacts: linkedArtifactRefs.length,
      },
      updated_at: session.updated_at,
    };
  }

  async getObservationDetail(request: CoworkObservationDetailRequest): Promise<JsonObject> {
    const session = await this.requireSession(request.sessionId, request.traceId ?? "");
    const detailId = cleanString(request.detailId);
    const detail = jsonSafeObject(session.observation_details[detailId]);
    if (!Object.keys(detail).length) {
      return {
        id: detailId,
        subject_id: detailId,
        subject_type: "unknown",
        state: "unavailable",
        summary: "Observation detail is not available.",
        content: "",
        unavailable_reason: "Detail was not persisted or has expired.",
      };
    }
    const sensitivity = cleanString(detail.sensitivity);
    const requester = cleanString(request.requesterAgentId);
    const permitted = arrayValue(detail.permitted_agent_ids).map(stringValue);
    if (stringValue(detail.state) === "available" && sensitivity && requester && !permitted.includes(requester)) {
      return {
        ...detail,
        state: "unauthorized",
        content: "",
        redacted: true,
        unavailable_reason: "Requester is not permitted to open this sensitive observation detail.",
      };
    }
    if (stringValue(detail.state) !== "available" || detail.redacted === true) {
      return { ...detail, content: "" };
    }
    return detail;
  }

  async deliverEnvelope(request: DeliverCoworkEnvelopeRequest): Promise<{ session: CoworkSession; message: CoworkMailboxMessage; record: JsonObject }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const mailbox = new CoworkMailbox({
      now: this.now,
      idGenerator: this.idGenerator,
    });
    const message = mailbox.deliver(session, request.envelope);
    const record = Object.values(session.mailbox).find((item) => item.message_id === message.id) ?? {};
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      message: saved.messages[message.id] as CoworkMailboxMessage,
      record: jsonSafeObject(saved.mailbox[stringValue(record.id)] ?? record),
    };
  }

  async markMailboxMessagesRead(request: MarkCoworkMailboxReadRequest): Promise<{ session: CoworkSession; messages: CoworkMailboxMessage[] }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const mailbox = new CoworkMailbox({
      now: this.now,
      idGenerator: this.idGenerator,
    });
    const messages = mailbox.markMessagesRead(session, request.agentId);
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      messages: messages.map((message) => saved.messages[message.id] as CoworkMailboxMessage).filter(Boolean),
    };
  }

  async expireMailboxRecords(request: CoworkSessionControlRequest): Promise<{ session: CoworkSession; records: JsonObject[] }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const mailbox = new CoworkMailbox({
      now: this.now,
      idGenerator: this.idGenerator,
    });
    const records = mailbox.expireRecords(session);
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      records: records.map((record) => jsonSafeObject(saved.mailbox[stringValue(record.id)] ?? record)),
    };
  }

  async escalateStaleBlockers(request: CoworkSessionControlRequest): Promise<{ session: CoworkSession; records: JsonObject[] }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const mailbox = new CoworkMailbox({
      now: this.now,
      idGenerator: this.idGenerator,
    });
    const records = mailbox.escalateStaleBlockers(session);
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      records: records.map((record) => jsonSafeObject(saved.mailbox[stringValue(record.id)] ?? record)),
    };
  }

  async selectBranch(request: SelectCoworkBranchRequest): Promise<{ session: CoworkSession; branch: CoworkBranch | null; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const branchId = cleanString(request.branchId);
    if (!session.branches[branchId]) {
      return { session, branch: null, result: `Error: branch '${branchId}' not found.` };
    }
    this.captureCurrentBranchState(session);
    const branch = session.branches[branchId];
    session.current_branch_id = branch.id;
    session.workflow_mode = normalizeArchitectureName(branch.architecture);
    session.status = branch.status;
    session.completion_decision = jsonSafeObject(branch.completion_decision);
    session.current_focus_task = stringValue(branch.runtime_state.current_focus_task) || session.current_focus_task;
    session.events = [
      ...session.events,
      this.event("branch.selected", `Selected cowork branch '${branch.id}'`, {
        actorId: "user",
        data: { branch_id: branch.id, architecture: branch.architecture },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      branch: saved.branches[branch.id] ?? branch,
      result: `Selected cowork branch '${branch.id}'.`,
    };
  }

  async deriveBranch(request: DeriveCoworkBranchRequest): Promise<{ session: CoworkSession; branch: CoworkBranch | null; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const sourceId = cleanString(request.sourceBranchId) || session.current_branch_id || DEFAULT_BRANCH_ID;
    if (!session.branches[sourceId]) {
      return { session, branch: null, result: `Error: source branch '${sourceId}' not found.` };
    }
    this.captureCurrentBranchState(session);
    const architecture = normalizeArchitectureName(request.targetArchitecture ?? "adaptive_starter");
    const branchId = this.idGenerator("br");
    const source = session.branches[sourceId];
    const summary = cleanString(request.inheritedContextSummary) || stageContextSummary(session, source);
    const stageId = this.idGenerator("stage");
    const eventId = this.idGenerator("evt");
    const stage = {
      id: stageId,
      source_branch_id: sourceId,
      target_branch_id: branchId,
      source_architecture: source.architecture,
      target_architecture: architecture,
      derivation_reason: cleanString(request.reason),
      source_summary: stageSourceSummary(session, source),
      inherited_context_summary: summary,
      artifact_refs: session.artifacts.slice(-20),
      message_refs: stageMessageRefs(session),
      decisions: stageDecisions(session),
      created_at: this.now(),
    };
    session.stage_records = [...session.stage_records, stage];
    const branch: CoworkBranch = {
      id: branchId,
      title: cleanString(request.title) || `${titleizeArchitecture(architecture)} branch`,
      architecture,
      status: "active",
      topology_reference: { branch_id: branchId, architecture },
      source_branch_id: sourceId,
      source_stage_record_id: stageId,
      derivation_event_id: eventId,
      derivation_reason: cleanString(request.reason),
      inherited_context_summary: summary,
      runtime_state: {
        current_focus_task: summary || session.goal,
        source_branch_status: source.status,
      },
      completion_decision: {},
      branch_result: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    session.branches[branchId] = branch;
    session.current_branch_id = branchId;
    session.workflow_mode = architecture;
    session.status = "active";
    session.current_focus_task = stringValue(branch.runtime_state.current_focus_task);
    session.events = [
      ...session.events,
      this.event("branch.derived", `Derived branch '${branch.id}' from '${sourceId}'`, {
        actorId: "user",
        data: {
          branch_id: branch.id,
          source_branch_id: sourceId,
          target_architecture: architecture,
          derivation_reason: cleanString(request.reason),
          stage_record_id: stageId,
          derivation_event_id: eventId,
          inherited_context_summary: summary,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      branch: saved.branches[branchId] ?? branch,
      result: `Derived branch '${branchId}' from '${sourceId}'.`,
    };
  }

  async selectSessionFinalResult(
    request: SelectCoworkFinalResultRequest,
  ): Promise<{ session: CoworkSession; finalResult: JsonObject | null; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const branchId = cleanString(request.branchId);
    const branch = session.branches[branchId];
    if (!branch) {
      return { session, finalResult: null, result: `Error: branch '${branchId}' not found.` };
    }
    const branchResult = jsonSafeObject(branch.branch_result);
    if (!Object.keys(branchResult).length) {
      return { session, finalResult: null, result: `Error: branch '${branchId}' has no result to select.` };
    }
    const expectedResultId = cleanString(request.resultId);
    const branchResultId = stringValue(branchResult.id);
    if (expectedResultId && expectedResultId !== branchResultId) {
      return { session, finalResult: null, result: `Error: branch result '${expectedResultId}' not found on branch '${branchId}'.` };
    }
    const finalResult: JsonObject = {
      id: this.idGenerator("final"),
      source: "selected_branch_result",
      selected_branch_id: branch.id,
      selected_result_id: branchResultId,
      source_branch_ids: [branch.id],
      source_result_ids: [branchResultId],
      summary: stringValue(branchResult.summary),
      artifacts: stringList(branchResult.artifacts),
      decision: jsonSafeObject(branchResult.decision),
      confidence: numberOrNull(branchResult.confidence),
      created_at: this.now(),
    };
    session.session_final_result = finalResult;
    session.events = [
      ...session.events,
      this.event("session.final_result.selected", `Selected branch result '${branchResultId}' as the session final result`, {
        actorId: "user",
        data: {
          selected_branch_id: branch.id,
          selected_result_id: branchResultId,
          session_final_result_id: stringValue(finalResult.id),
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      finalResult: jsonSafeObject(saved.session_final_result),
      result: `Selected branch result '${branchResultId}' as the session final result.`,
    };
  }

  async mergeBranchResults(
    request: MergeCoworkBranchResultsRequest,
  ): Promise<{ session: CoworkSession; finalResult: JsonObject | null; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const selectedIds = unique(request.branchIds.map(cleanString).filter((branchId) => Boolean(session.branches[branchId])));
    if (selectedIds.length < 2) {
      return { session, finalResult: null, result: "Error: at least two existing branches are required to merge branch results." };
    }
    const missing = selectedIds.filter((branchId) => !Object.keys(jsonSafeObject(session.branches[branchId].branch_result)).length);
    if (missing.length > 0) {
      return { session, finalResult: null, result: `Error: branch result missing for: ${missing.join(", ")}.` };
    }
    const results = selectedIds.map((branchId) => jsonSafeObject(session.branches[branchId].branch_result));
    const confidences = results.map((result) => numberOrNull(result.confidence)).filter((value): value is number => value !== null);
    const sourceResultIds = results.map((result) => stringValue(result.id)).filter(Boolean);
    const mergedSummary = cleanString(request.summary) || results
      .map((result) => `## ${session.branches[stringValue(result.source_branch_id)]?.title ?? stringValue(result.source_branch_id)}\n${stringValue(result.summary)}`)
      .join("\n\n");
    const finalResult: JsonObject = {
      id: this.idGenerator("final"),
      source: "branch_merge",
      source_branch_ids: selectedIds,
      source_result_ids: sourceResultIds,
      summary: mergedSummary,
      artifacts: unique(results.flatMap((result) => stringList(result.artifacts))),
      decision: {
        operation: "branch_merge",
        source_branch_ids: selectedIds,
        source_result_ids: sourceResultIds,
        created_at: this.now(),
      },
      confidence: confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      created_at: this.now(),
    };
    session.session_final_result = finalResult;
    session.events = [
      ...session.events,
      this.event("session.final_result.merged", `Merged ${results.length} branch results into a candidate session final result`, {
        actorId: "user",
        data: {
          source_branch_ids: selectedIds,
          source_result_ids: sourceResultIds,
          session_final_result_id: stringValue(finalResult.id),
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return {
      session: saved,
      finalResult: jsonSafeObject(saved.session_final_result),
      result: `Merged ${results.length} branch results into a candidate session final result.`,
    };
  }

  async pauseSession(request: CoworkSessionControlRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    if (session.status === "completed") {
      return { session, result: `Session ${session.id} is already completed.` };
    }
    session.status = "paused";
    const branch = currentBranch(session);
    if (branch) {
      branch.status = "paused";
      branch.updated_at = this.now();
    }
    session.events = [
      ...session.events,
      this.event("session.paused", "Cowork session paused"),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `Paused cowork session ${session.id}.` };
  }

  async resumeSession(request: CoworkSessionControlRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    if (session.status === "completed") {
      return { session, result: `Session ${session.id} is already completed.` };
    }
    session.status = "active";
    const branch = currentBranch(session);
    if (branch?.status === "paused") {
      branch.status = "active";
      branch.updated_at = this.now();
    }
    session.events = [
      ...session.events,
      this.event("session.resumed", "Cowork session resumed"),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `Resumed cowork session ${session.id}.` };
  }

  async emergencyStopSession(request: CoworkEmergencyStopRequest): Promise<{ session: CoworkSession; agentStep: JsonObject }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const explanation = cleanString(request.reason) || "Emergency Stop requested by user.";
    const actorId = cleanString(request.actorId) || "user";
    session.status = "paused";
    session.stop_reason = "emergency_stop";
    session.budget_usage = {
      ...defaultBudgetUsage(),
      ...jsonSafeObject(session.budget_usage),
      stop_reason: "emergency_stop",
    };
    const branch = currentBranch(session);
    if (branch) {
      branch.status = "paused";
      branch.updated_at = this.now();
    }
    session.events = [
      ...session.events,
      this.event("scheduler.stop", explanation, {
        actorId: "scheduler",
        data: {
          stop_reason: "emergency_stop",
          control_scope: "emergency_stop",
          actor_id: actorId,
          branch_id: session.current_branch_id || DEFAULT_BRANCH_ID,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("scheduler", "Stop reason", {
        sessionId: session.id,
        actorId: "scheduler",
        status: "completed",
        summary: explanation,
        data: {
          stop_reason: "emergency_stop",
          control_scope: "emergency_stop",
          actor_id: actorId,
          branch_id: session.current_branch_id || DEFAULT_BRANCH_ID,
        },
      }),
    ];
    const step = {
      id: this.idGenerator("step"),
      session_id: session.id,
      branch_id: session.current_branch_id || DEFAULT_BRANCH_ID,
      architecture: currentBranch(session)?.architecture ?? session.workflow_mode,
      agent_id: "scheduler",
      action_kind: "emergency_stop",
      scheduler_reason: explanation,
      status: "stopped",
      started_at: this.now(),
      ended_at: this.now(),
      duration_ms: 0,
      task_id: null,
      work_unit_id: null,
      input_summary: cleanString(request.reason),
      output_summary: "Emergency Stop recorded; future scheduling is paused.",
      error: null,
      linked_message_ids: [],
      linked_artifact_refs: [],
      linked_task_ids: [],
      linked_envelope_ids: [],
      tool_observations: [],
      browser_observations: [],
      summary: null,
      detail_ref: "",
      source_span_id: null,
      source_event_id: null,
      projected: false,
    };
    session.agent_steps = [...session.agent_steps, step];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, agentStep: step };
  }

  async updateBudget(request: UpdateCoworkBudgetRequest): Promise<{ session: CoworkSession; budget: JsonObject }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    session.budget_limits = normalizeBudgetLimits({
      ...jsonSafeObject(session.budget_limits),
      ...request.budgets,
    });
    session.budget_usage = {
      ...defaultBudgetUsage(),
      ...jsonSafeObject(session.budget_usage),
    };
    const budget = budgetState(session);
    session.events = [
      ...session.events,
      this.event("budget.updated", "Cowork budget limits updated", {
        actorId: "user",
        data: { budget },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, budget };
  }

  async sendMessage(request: SendCoworkMessageRequest): Promise<{ session: CoworkSession; message: JsonObject }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const senderId = slug(request.senderId, "user");
    const validRecipients = unique(request.recipientIds.map((recipient) => slug(recipient, "agent")))
      .filter((recipient) => recipient === "user" || Boolean(session.agents[recipient]));
    const recipientIds = validRecipients.length > 0 ? validRecipients : Object.keys(session.agents);
    const thread = this.ensureThread(session, request.threadId, request.topic || "General discussion", [senderId, ...recipientIds]);
    for (const participant of [senderId, ...recipientIds]) {
      if ((participant === "user" || session.agents[participant]) && !stringList(thread.participant_ids).includes(participant)) {
        thread.participant_ids = [...stringList(thread.participant_ids), participant];
      }
    }

    const messageId = this.idGenerator("msg");
    const message = {
      id: messageId,
      thread_id: cleanString(thread.id),
      sender_id: senderId,
      recipient_ids: recipientIds,
      content: cleanString(request.content),
      topic: cleanString(request.topic),
      event_type: cleanString(request.eventType),
      created_at: this.now(),
      read_by: [senderId],
    };
    session.messages[messageId] = message;
    thread.message_ids = [...stringList(thread.message_ids), messageId];
    thread.updated_at = this.now();
    thread.last_message_at = message.created_at;
    for (const recipientId of recipientIds) {
      const agent = session.agents[recipientId];
      if (request.wakeRecipients !== false && agent && !agent.inbox.includes(messageId)) {
        agent.inbox = [...agent.inbox, messageId];
        if (agent.status === "idle" || agent.status === "done") {
          agent.status = "waiting";
        }
      }
    }
    session.events = [
      ...session.events,
      this.event("message.sent", `${senderId} sent a message to ${recipientIds.join(", ")}`, {
        actorId: senderId,
        data: {
          thread_id: message.thread_id,
          message_id: messageId,
          recipients: recipientIds,
          topic: message.topic,
          event_type: message.event_type,
          wake_recipients: request.wakeRecipients !== false,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, message: saved.messages[messageId] };
  }

  async steerSwarm(request: SteerCoworkSwarmRequest): Promise<{ result: string; session: CoworkSession }> {
    const traceId = request.traceId ?? "";
    const text = cleanString(request.instruction);
    const loaded = await this.requireSession(request.sessionId, traceId);
    if (!text) {
      return { result: "Error: instruction is required", session: loaded };
    }
    const leadId = leadAgentId(loaded.agents);
    const sent = await this.sendMessage({
      traceId,
      sessionId: loaded.id,
      senderId: "user",
      recipientIds: leadId ? [leadId] : [],
      content: text,
    });
    const session = sent.session;
    const plan = jsonSafeObject(session.swarm_plan);
    if (Object.keys(plan).length > 0) {
      const updates = Array.isArray(plan.user_steering)
        ? plan.user_steering.filter(isJsonObject).map(jsonSafeObject)
        : [];
      updates.push({
        instruction: text,
        created_at: this.now(),
        actor_id: "user",
      });
      plan.user_steering = updates.slice(-40);
      plan.updated_at = this.now();
      if (plan.status === "blocked") {
        plan.status = "active";
      }
      session.swarm_plan = plan;
    }
    const data = { lead_agent_id: leadId, instruction: text.slice(0, 500) };
    session.events = [
      ...session.events,
      this.event("swarm.user_steered", "User steering instruction routed to the swarm lead", {
        actorId: "user",
        data,
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("swarm", "User steering", {
        sessionId: session.id,
        actorId: "user",
        status: "completed",
        summary: "User steering instruction routed to the swarm lead",
        data,
      }),
    ];
    if (session.status === "completed") {
      session.status = "active";
    }
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { result: `Steering instruction routed to ${leadId}.`, session: saved };
  }

  async addTask(request: AddCoworkTaskRequest): Promise<{ session: CoworkSession; task: CoworkTask }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const assignedAgentId = assignedAgentIdForMutation(request.assignedAgentId, session.agents);
    const taskId = this.idGenerator("task");
    const task: CoworkTask = {
      id: taskId,
      title: cleanString(request.title) || "Untitled task",
      description: cleanString(request.description) || cleanString(request.title),
      assigned_agent_id: assignedAgentId,
      dependencies: (request.dependencies ?? []).map((dependency) => slug(dependency, "task")),
      status: "pending",
      result: null,
      result_data: {},
      confidence: null,
      error: null,
      priority: intValue(request.priority),
      expected_output: cleanString(request.expectedOutput),
      review_required: request.reviewRequired === true,
      reviewer_agent_ids: (request.reviewerAgentIds ?? []).map((reviewer) => slug(reviewer, "agent")),
      review_status: "",
      fanout_group_id: cleanString(request.fanoutGroupId),
      merge_task_id: request.mergeTaskId ? slug(request.mergeTaskId, "task") : "",
      source_blueprint_id: cleanString(request.sourceBlueprintId),
      source_event_id: cleanString(request.sourceEventId),
      runtime_created: request.runtimeCreated !== false,
      created_at: this.now(),
      updated_at: this.now(),
    };
    session.tasks[taskId] = task;
    if (session.status === "completed") {
      session.status = "active";
    }
    session.current_focus_task = `${task.title}: ${task.description}`;
    const assignedAgent = assignedAgentId ? session.agents[assignedAgentId] : undefined;
    if (assignedAgent && (assignedAgent.status === "idle" || assignedAgent.status === "done")) {
      assignedAgent.status = "waiting";
    }
    const message = assignedAgent
      ? `Task '${task.title}' assigned to ${assignedAgent.name}`
      : `Task '${task.title}' added to the shared task pool`;
    session.events = [
      ...session.events,
      this.event("task.created", message, {
        data: {
          task_id: task.id,
          assigned_agent_id: assignedAgentId,
          dependencies: task.dependencies,
          review_required: task.review_required,
          fanout_group_id: task.fanout_group_id,
          merge_task_id: task.merge_task_id,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("task", "Task created", {
        sessionId: session.id,
        actorId: assignedAgentId ?? undefined,
        status: task.status,
        inputRef: task.description,
        summary: message,
        data: {
          task_id: task.id,
          assigned_agent_id: assignedAgentId,
          dependencies: task.dependencies,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, task: saved.tasks[taskId] };
  }

  async assignTask(request: AssignCoworkTaskRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const task = session.tasks[request.taskId];
    if (!task) {
      return { session, result: `Error: task '${request.taskId}' not found` };
    }
    const agentId = slug(request.agentId);
    const agent = session.agents[agentId];
    if (!agent) {
      return { session, result: `Error: agent '${agentId}' not found` };
    }
    if (task.status !== "pending" && task.status !== "in_progress") {
      return { session, result: `Error: task '${task.id}' is already ${task.status}` };
    }
    task.assigned_agent_id = agentId;
    task.updated_at = this.now();
    if (session.status === "completed") {
      session.status = "active";
    }
    session.current_focus_task = `${task.title}: ${task.description}`;
    if (agent.status === "idle" || agent.status === "done") {
      agent.status = "waiting";
    }
    const message = `Task '${task.title}' assigned to ${agent.name}`;
    session.events = [
      ...session.events,
      this.event("task.assigned", message, {
        actorId: agentId,
        data: {
          task_id: task.id,
          assigned_agent_id: agentId,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("task", "Task assigned", {
        sessionId: session.id,
        actorId: agentId,
        status: task.status,
        summary: message,
        data: {
          task_id: task.id,
          assigned_agent_id: agentId,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `${message}.` };
  }

  async retryTask(request: RetryCoworkTaskRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const task = session.tasks[request.taskId];
    if (!task) {
      return { session, result: `Error: task '${request.taskId}' not found` };
    }
    if (!["failed", "skipped", "completed"].includes(task.status)) {
      return { session, result: `Error: task '${task.id}' is ${task.status}; only failed, skipped, or completed tasks can be retried` };
    }
    const previousStatus = task.status;
    task.status = "pending";
    task.error = null;
    task.updated_at = this.now();
    if (session.status === "completed") {
      session.status = "active";
    }
    if (task.assigned_agent_id && session.agents[task.assigned_agent_id]) {
      const agent = session.agents[task.assigned_agent_id];
      if (agent.status === "done" || agent.status === "failed" || agent.status === "idle") {
        agent.status = "waiting";
      }
    }
    const message = `Task '${task.title}' queued for retry`;
    session.events = [
      ...session.events,
      this.event("task.retried", message, {
        actorId: "user",
        data: {
          task_id: task.id,
          previous_status: previousStatus,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("task", "Task retried", {
        sessionId: session.id,
        actorId: "user",
        status: "pending",
        summary: message,
        data: {
          task_id: task.id,
          previous_status: previousStatus,
          assigned_agent_id: task.assigned_agent_id,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `${message}.` };
  }

  async retryWorkUnit(request: CoworkWorkUnitActionRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const workUnit = findSwarmWorkUnit(session, request.workUnitId);
    if (!workUnit) {
      return { session, result: `Error: work unit '${request.workUnitId}' not found` };
    }
    const attempts = intValue(workUnit.attempts);
    const maxAttempts = Math.max(1, intValue(workUnit.max_attempts) || 1);
    if (attempts >= maxAttempts) {
      return { session, result: `Error: work unit '${request.workUnitId}' reached max attempts` };
    }
    workUnit.attempts = attempts + 1;
    workUnit.status = "pending";
    workUnit.error = null;
    workUnit.priority = intValue(workUnit.priority) + 10;
    workUnit.priority_boost_reason = cleanString(request.reason) || "user_retry";
    workUnit.updated_at = this.now();
    const sourceTaskId = cleanString(workUnit.source_task_id);
    const task = sourceTaskId ? session.tasks[sourceTaskId] : undefined;
    if (task) {
      task.status = "pending";
      task.error = null;
      task.updated_at = cleanString(workUnit.updated_at);
    }
    session.swarm_plan = updateWorkUnitReadiness(session.swarm_plan, session.tasks, this.now);
    const message = `Retry requested for work unit '${cleanString(workUnit.title) || request.workUnitId}'`;
    session.events = [
      ...session.events,
      this.event("swarm.work_unit_retried", message, {
        actorId: "user",
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
          attempts: intValue(workUnit.attempts),
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("swarm", "Work unit retried", {
        sessionId: session.id,
        actorId: "user",
        status: cleanString(workUnit.status),
        summary: message,
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
          attempts: intValue(workUnit.attempts),
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `Work unit '${cleanString(workUnit.title) || request.workUnitId}' queued for retry.` };
  }

  async skipWorkUnit(request: CoworkWorkUnitActionRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const workUnit = findSwarmWorkUnit(session, request.workUnitId);
    if (!workUnit) {
      return { session, result: `Error: work unit '${request.workUnitId}' not found` };
    }
    workUnit.status = "skipped";
    workUnit.skip_reason = cleanString(request.reason);
    workUnit.updated_at = this.now();
    const sourceTaskId = cleanString(workUnit.source_task_id);
    const task = sourceTaskId ? session.tasks[sourceTaskId] : undefined;
    if (task) {
      task.status = "skipped";
      task.result = cleanString(request.reason) || "Skipped.";
      task.updated_at = cleanString(workUnit.updated_at);
    }
    session.swarm_plan = updateWorkUnitReadiness(session.swarm_plan, session.tasks, this.now);
    const message = `Work unit '${cleanString(workUnit.title) || request.workUnitId}' skipped`;
    session.events = [
      ...session.events,
      this.event("swarm.work_unit_skipped", message, {
        actorId: "user",
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
          source_task_id: sourceTaskId,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("swarm", "Work unit skipped", {
        sessionId: session.id,
        actorId: "user",
        status: "skipped",
        summary: message,
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
          source_task_id: sourceTaskId,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `${message}.` };
  }

  async cancelWorkUnit(request: CoworkWorkUnitActionRequest): Promise<{ session: CoworkSession; result: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const workUnit = findSwarmWorkUnit(session, request.workUnitId);
    if (!workUnit) {
      return { session, result: `Error: work unit '${request.workUnitId}' not found` };
    }
    workUnit.status = "cancelled";
    workUnit.cancel_reason = cleanString(request.reason);
    workUnit.updated_at = this.now();
    const sourceTaskId = cleanString(workUnit.source_task_id);
    const task = sourceTaskId ? session.tasks[sourceTaskId] : undefined;
    if (task) {
      task.status = "skipped";
      task.result = cleanString(request.reason) || "Cancelled.";
      task.updated_at = cleanString(workUnit.updated_at);
    }
    const message = `Work unit '${cleanString(workUnit.title) || request.workUnitId}' cancelled`;
    session.events = [
      ...session.events,
      this.event("swarm.work_unit_cancelled", message, {
        actorId: "user",
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("swarm", "Work unit cancelled", {
        sessionId: session.id,
        actorId: "user",
        status: "cancelled",
        summary: message,
        data: {
          work_unit_id: request.workUnitId,
          reason: cleanString(request.reason),
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, result: `${message}.` };
  }

  async requestTaskReview(request: RequestCoworkTaskReviewRequest): Promise<{ session: CoworkSession; reviewTask: CoworkTask; review_task_id: string }> {
    const traceId = request.traceId ?? "";
    const session = await this.requireSession(request.sessionId, traceId);
    const source = session.tasks[request.taskId];
    if (!source) {
      throw new Error(`Error: task '${request.taskId}' not found`);
    }
    const reviewerId = reviewerAgentId(request.reviewerAgentId, session.agents);
    const existing = Object.values(session.tasks).find((task) => (
      (task.status === "pending" || task.status === "in_progress")
      && task.assigned_agent_id === reviewerId
      && task.dependencies.length === 1
      && task.dependencies[0] === source.id
      && looksLikeReviewTask(task)
    ));
    if (existing) {
      return { session, reviewTask: existing, review_task_id: existing.id };
    }

    const reviewTaskId = this.idGenerator("task");
    const reviewTask: CoworkTask = {
      id: reviewTaskId,
      title: `Review ${source.title}`,
      description: [
        "Review the source task for correctness, completeness, risks, missing evidence, and whether it satisfies the original goal.",
        `Source task: ${source.id}.`,
        `Result: ${(source.result ?? "").slice(0, 1000)}`,
      ].join(" "),
      assigned_agent_id: reviewerId,
      dependencies: [source.id],
      status: "pending",
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
      runtime_created: true,
      created_at: this.now(),
      updated_at: this.now(),
    };
    session.tasks[reviewTaskId] = reviewTask;
    if (session.agents[reviewerId] && (session.agents[reviewerId].status === "idle" || session.agents[reviewerId].status === "done")) {
      session.agents[reviewerId].status = "waiting";
    }
    session.current_focus_task = `${reviewTask.title}: ${reviewTask.description}`;
    session.events = [
      ...session.events,
      this.event("task.created", `Task '${reviewTask.title}' assigned to ${session.agents[reviewerId]?.name ?? reviewerId}`, {
        data: {
          task_id: reviewTask.id,
          assigned_agent_id: reviewerId,
          dependencies: reviewTask.dependencies,
          review_required: reviewTask.review_required,
          fanout_group_id: reviewTask.fanout_group_id,
          merge_task_id: reviewTask.merge_task_id,
        },
      }),
      this.event("task.review_requested", `Review requested for task '${source.title}'`, {
        actorId: "user",
        data: {
          task_id: source.id,
          review_task_id: reviewTask.id,
          reviewer_agent_id: reviewerId,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      this.traceSpan("task", "Task created", {
        sessionId: session.id,
        actorId: reviewerId,
        status: reviewTask.status,
        inputRef: reviewTask.description,
        summary: `Task '${reviewTask.title}' assigned to ${session.agents[reviewerId]?.name ?? reviewerId}`,
        data: {
          task_id: reviewTask.id,
          assigned_agent_id: reviewerId,
          dependencies: reviewTask.dependencies,
        },
      }),
      this.traceSpan("review", "Review requested", {
        sessionId: session.id,
        actorId: "user",
        status: "pending",
        summary: `Review requested for task '${source.title}'`,
        data: {
          task_id: source.id,
          review_task_id: reviewTask.id,
          reviewer_agent_id: reviewerId,
        },
      }),
    ];
    session.updated_at = this.now();
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, reviewTask: saved.tasks[reviewTaskId], review_task_id: reviewTaskId };
  }

  async createSession(request: CreateCoworkSessionRequest): Promise<CoworkSession> {
    const traceId = request.traceId ?? "";
    const timestamp = this.now();
    const sessionId = this.idGenerator("cw");
    const workflowMode = normalizeArchitectureName(request.workflowMode);
    const title = cleanString(request.title) || "Cowork Session";
    const goal = cleanString(request.goal);
    const agents = this.materializeAgents(request.agents ?? [], goal);
    const tasks = this.materializeTasks(request.tasks ?? [], goal, agents);
    const workspaceDir = await this.ensureWorkspace(sessionId, traceId);
    const currentFocusTask = deriveFocusTask(tasks, goal);
    const leadId = leadAgentId(agents);
    const threadId = this.idGenerator("thread");
    const messageId = this.idGenerator("msg");
    const event = this.event("session.created", `Created cowork session '${title}'`, {
      actorId: "user",
      data: {
        goal,
        workflow_mode: workflowMode,
        architecture: workflowMode,
        architecture_policy: "ArchitecturePolicyRegistry",
        focus_task: currentFocusTask,
      },
    });
    const traceSpan = this.traceSpan("session", "Session created", {
      sessionId,
      actorId: "user",
      summary: `Created cowork session '${title}'`,
      data: {
        goal,
        workflow_mode: workflowMode,
        architecture: workflowMode,
        architecture_policy: "ArchitecturePolicyRegistry",
        focus_task: currentFocusTask,
      },
    });

    if (agents[leadId]) {
      agents[leadId] = {
        ...agents[leadId],
        status: agents[leadId].status === "done" || agents[leadId].status === "idle" ? "waiting" : agents[leadId].status,
        inbox: [...agents[leadId].inbox, messageId],
      };
    }

    const session = normalizeCoworkSession({
      id: sessionId,
      title,
      goal,
      status: "active",
      workflow_mode: workflowMode,
      current_branch_id: DEFAULT_BRANCH_ID,
      current_focus_task: currentFocusTask,
      workspace_dir: workspaceDir,
      agents,
      tasks,
      threads: {
        [threadId]: {
          id: threadId,
          topic: title,
          summary: "",
          participant_ids: ["user", leadId].filter(Boolean),
          message_ids: [messageId],
          created_at: timestamp,
          updated_at: timestamp,
          last_message_at: timestamp,
        },
      },
      messages: {
        [messageId]: {
          id: messageId,
          thread_id: threadId,
          sender_id: "user",
          recipient_ids: [leadId].filter(Boolean),
          content: `Goal: ${goal}`,
          created_at: timestamp,
          read_by: ["user"],
        },
      },
      mailbox: {},
      events: [event],
      trace_spans: [traceSpan],
      agent_steps: [],
      observation_details: {},
      sensitive_artifacts: {},
      delegation_guardrails: {},
      delegated_briefs: {},
      delegated_tasks: {},
      isolated_sub_agent_contexts: {},
      sub_agent_results: {},
      run_metrics: [],
      scheduler_decisions: [],
      branches: {
        [DEFAULT_BRANCH_ID]: {
          id: DEFAULT_BRANCH_ID,
          title: "Default branch",
          architecture: workflowMode,
          status: "active",
          topology_reference: {},
          source_branch_id: null,
          source_stage_record_id: null,
          derivation_event_id: null,
          derivation_reason: "",
          inherited_context_summary: "",
          runtime_state: {},
          completion_decision: {},
          branch_result: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      },
      stage_records: [],
      artifacts: [],
      shared_memory: {},
      shared_summary: "",
      final_draft: "",
      completion_decision: {},
      session_final_result: null,
      swarm_plan: {},
      budget_limits: request.budgets ?? {},
      budget_usage: {},
      stop_reason: "",
      blueprint: request.blueprint ?? {},
      blueprint_diagnostics: request.blueprintDiagnostics ?? [],
      runtime_state: request.runtimeState ?? {},
      created_at: timestamp,
      updated_at: timestamp,
      rounds: 0,
      no_progress_rounds: 0,
    });
    const saved = await this.store.writeSnapshot(session, traceId);
    this.notifyListeners(saved, event);
    return saved;
  }

  async createSessionFromBlueprint(
    request: CreateCoworkSessionFromBlueprintRequest,
  ): Promise<CreateCoworkSessionFromBlueprintResult> {
    const traceId = request.traceId ?? "";
    const preview = previewBlueprint(request.blueprint);
    const diagnostics = preview.diagnostics.map(jsonSafeObject);
    if (!preview.ok) {
      return { session: null, diagnostics };
    }

    const blueprint = preview.blueprint;
    let session = await this.createSession({
      traceId,
      goal: blueprint.goal,
      title: blueprint.title,
      workflowMode: blueprint.workflow_mode,
      agents: blueprint.agents.map((agent) => ({
        ...agent,
        source_blueprint_id: agent.id,
      })),
      tasks: blueprint.tasks.map((task) => ({
        ...task,
        source_blueprint_id: task.id,
      })),
      budgets: blueprint.budgets,
      blueprint,
      blueprintDiagnostics: diagnostics,
      runtimeState: request.runtimeState ?? {},
    });
    session = {
      ...session,
      events: [
        ...session.events,
        this.event("blueprint.compiled", "Cowork blueprint compiled into a session", {
          actorId: "user",
          data: {
            blueprint_id: blueprint.id,
            diagnostics,
          },
        }),
      ],
      trace_spans: [
        ...session.trace_spans,
        this.traceSpan("blueprint", "Blueprint compiled", {
          sessionId: session.id,
          actorId: "user",
          summary: "Cowork blueprint compiled into a session",
          data: {
            blueprint_id: blueprint.id,
            agent_count: blueprint.agents.length,
            task_count: blueprint.tasks.length,
          },
        }),
      ],
      updated_at: this.now(),
    };
    const saved = await this.store.writeSnapshot(normalizeCoworkSession(session), traceId);
    return { session: saved, diagnostics };
  }

  private materializeAgents(rawAgents: CoworkAgentInput[], goal: string): Record<string, CoworkAgent> {
    const sourceAgents = rawAgents.length > 0 ? rawAgents : defaultTeam(goal);
    const agents: Record<string, CoworkAgent> = {};
    for (const [index, raw] of sourceAgents.entries()) {
      const baseId = slug(raw.id ?? raw.name ?? raw.role ?? `agent_${index + 1}`, "agent");
      const id = dedupeId(baseId, agents);
      agents[id] = {
        ...jsonSafeObject(raw),
        id,
        name: cleanString(raw.name) || id,
        role: cleanString(raw.role) || "Collaborator",
        goal: cleanString(raw.goal) || goal,
        responsibilities: stringList(raw.responsibilities),
        tools: agentTools(raw.tools),
        subscriptions: agentSubscriptions(raw, id),
        communication_policy: cleanString(raw.communication_policy)
          || "Coordinate through cowork messages when another agent can unblock or verify work.",
        context_policy: cleanString(raw.context_policy)
          || "Keep a concise private summary and refer to artifacts or thread summaries instead of full logs.",
        status: "idle",
        private_summary: "",
        inbox: [],
        current_task_id: null,
        current_task_title: null,
        last_active_at: null,
        rounds: 0,
        parent_agent_id: nullableString(raw.parent_agent_id),
        team_id: cleanString(raw.team_id),
        lifetime: cleanString(raw.lifetime) || "persistent",
        lifecycle_status: cleanString(raw.lifecycle_status) || "active",
        source_blueprint_id: cleanString(raw.source_blueprint_id) || cleanString(raw.id) || id,
        source_event_id: cleanString(raw.source_event_id),
        spawn_reason: cleanString(raw.spawn_reason),
        delegated_task_id: cleanString(raw.delegated_task_id),
        delegated_brief_id: cleanString(raw.delegated_brief_id),
        isolated_context_id: cleanString(raw.isolated_context_id),
        sub_agent_scope: cleanString(raw.sub_agent_scope),
      };
    }
    return agents;
  }

  private materializeTasks(rawTasks: CoworkTaskInput[], goal: string, agents: Record<string, CoworkAgent>): Record<string, CoworkTask> {
    const sourceTasks = rawTasks.length > 0
      ? rawTasks
      : [{
        id: "1",
        title: "Initial analysis",
        description: `Analyze the goal and propose concrete next steps: ${goal}`,
        assigned_agent_id: Object.keys(agents)[0] ?? null,
      }];
    const tasks: Record<string, CoworkTask> = {};
    for (const [index, raw] of sourceTasks.entries()) {
      const baseId = slug(raw.id ?? raw.title ?? `task_${index + 1}`, "task");
      const id = dedupeId(baseId, tasks);
      const assigned = assignmentFor(raw.assigned_agent_id, agents);
      tasks[id] = {
        ...jsonSafeObject(raw),
        id,
        title: cleanString(raw.title) || id,
        description: cleanString(raw.description) || cleanString(raw.title) || goal,
        assigned_agent_id: assigned,
        dependencies: stringList(raw.dependencies).map((item) => slug(item, "task")),
        status: "pending",
        result: null,
        result_data: {},
        confidence: null,
        error: null,
        priority: intValue(raw.priority),
        expected_output: cleanString(raw.expected_output),
        review_required: Boolean(raw.review_required),
        reviewer_agent_ids: stringList(raw.reviewer_agent_ids).map((item) => slug(item, "agent")),
        review_status: "",
        fanout_group_id: cleanString(raw.fanout_group_id),
        merge_task_id: raw.merge_task_id ? slug(raw.merge_task_id, "task") : "",
        source_blueprint_id: cleanString(raw.source_blueprint_id) || cleanString(raw.id) || id,
        source_event_id: cleanString(raw.source_event_id),
        runtime_created: Boolean(raw.runtime_created),
        created_at: this.now(),
        updated_at: this.now(),
      };
    }
    return tasks;
  }

  private async ensureWorkspace(sessionId: string, traceId: string): Promise<string> {
    if (!this.store.ensureSessionWorkspace) {
      return "";
    }
    return this.store.ensureSessionWorkspace(sessionId, traceId);
  }

  private async loadSession(sessionId: string, traceId: string): Promise<CoworkSession | null> {
    const session = await this.store.readSnapshot(sessionId, traceId);
    return session ? this.recoverLoadedSession(session, traceId) : null;
  }

  private async recoverLoadedSession(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    return this.recoverInterruptedRuntime(
      await this.replaySensitiveArtifacts(
        await this.replayObservationDetails(
          await this.replayBrowserObservations(
            await this.replayToolObservations(
              await this.replayAgentSteps(
                await this.replayTraceSpans(
                  await this.replayEventLog(session, traceId),
                  traceId,
                ),
                traceId,
              ),
              traceId,
            ),
            traceId,
          ),
          traceId,
        ),
        traceId,
      ),
    );
  }

  private async replayEventLog(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readEvents) {
      return session;
    }
    const events = await this.store.readEvents(session.id, traceId);
    if (events.length === 0) {
      return session;
    }
    const known = new Set(session.events.map((event) => event.id).filter(Boolean));
    const replayed = events.filter((event) => event.id && !known.has(event.id));
    if (replayed.length === 0) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      events: [...session.events, ...replayed].slice(-MAX_EVENT_COUNT),
    });
  }

  private async replayTraceSpans(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readTraceSpans) {
      return session;
    }
    const spans = await this.store.readTraceSpans(session.id, traceId);
    if (spans.length === 0) {
      return session;
    }
    const known = new Set(session.trace_spans.map((span) => stringValue(span.id)).filter(Boolean));
    const replayed = spans.filter((span) => {
      const spanId = stringValue(span.id);
      return spanId && !known.has(spanId);
    });
    if (replayed.length === 0) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      trace_spans: [...session.trace_spans, ...replayed.map(jsonSafeObject)].slice(-MAX_TRACE_SPAN_COUNT),
    });
  }

  private async replayAgentSteps(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readAgentSteps) {
      return session;
    }
    const steps = await this.store.readAgentSteps(session.id, traceId);
    if (steps.length === 0) {
      return session;
    }
    const known = new Set(session.agent_steps.map((step) => stringValue(step.id)).filter(Boolean));
    const replayed = steps.filter((step) => {
      const stepId = stringValue(step.id);
      return stepId && !known.has(stepId);
    });
    if (replayed.length === 0) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      agent_steps: [...session.agent_steps, ...replayed.map(jsonSafeObject)].slice(-MAX_AGENT_STEP_COUNT),
    });
  }

  private async replayToolObservations(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readToolObservations) {
      return session;
    }
    const observations = await this.store.readToolObservations(session.id, traceId);
    if (observations.length === 0) {
      return session;
    }
    let changed = false;
    const byStep = new Map<string, JsonObject[]>();
    for (const observation of observations.map(jsonSafeObject)) {
      const stepId = stringValue(observation.step_id);
      if (!stepId) {
        continue;
      }
      const items = byStep.get(stepId) ?? [];
      items.push(observation);
      byStep.set(stepId, items);
    }
    const agentSteps = session.agent_steps.map((step) => {
      const stepId = stringValue(step.id);
      const candidates = byStep.get(stepId) ?? [];
      if (candidates.length === 0) {
        return step;
      }
      const existing = jsonObjectArray(step.tool_observations);
      const known = new Set(existing.map((item) => stringValue(item.id)).filter(Boolean));
      const replayed = candidates.filter((observation) => {
        const observationId = stringValue(observation.id);
        return observationId && !known.has(observationId);
      });
      if (replayed.length === 0) {
        return step;
      }
      changed = true;
      return {
        ...step,
        tool_observations: [...existing, ...replayed],
      };
    });
    if (!changed) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      agent_steps: agentSteps,
    });
  }

  private async replayBrowserObservations(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readBrowserObservations) {
      return session;
    }
    const observations = await this.store.readBrowserObservations(session.id, traceId);
    if (observations.length === 0) {
      return session;
    }
    let changed = false;
    const byStep = new Map<string, JsonObject[]>();
    for (const observation of observations.map(jsonSafeObject)) {
      const stepId = stringValue(observation.step_id);
      if (!stepId) {
        continue;
      }
      const items = byStep.get(stepId) ?? [];
      items.push(observation);
      byStep.set(stepId, items);
    }
    const agentSteps = session.agent_steps.map((step) => {
      const stepId = stringValue(step.id);
      const candidates = byStep.get(stepId) ?? [];
      if (candidates.length === 0) {
        return step;
      }
      const existing = jsonObjectArray(step.browser_observations);
      const known = new Set(existing.map((item) => stringValue(item.id)).filter(Boolean));
      const replayed = candidates.filter((observation) => {
        const observationId = stringValue(observation.id);
        return observationId && !known.has(observationId);
      });
      if (replayed.length === 0) {
        return step;
      }
      changed = true;
      return {
        ...step,
        browser_observations: [...existing, ...replayed],
      };
    });
    if (!changed) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      agent_steps: agentSteps,
    });
  }

  private async replayObservationDetails(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readObservationDetails) {
      return session;
    }
    const details = await this.store.readObservationDetails(session.id, traceId);
    const additions: Record<string, JsonObject> = {};
    for (const detail of details.map(jsonSafeObject)) {
      const detailId = stringValue(detail.id);
      if (!detailId || session.observation_details[detailId] || additions[detailId]) {
        continue;
      }
      additions[detailId] = detail;
    }
    if (!Object.keys(additions).length) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      observation_details: {
        ...session.observation_details,
        ...additions,
      },
    });
  }

  private async replaySensitiveArtifacts(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    if (!this.store.readSensitiveArtifacts) {
      return session;
    }
    const artifacts = await this.store.readSensitiveArtifacts(session.id, traceId);
    const additions: Record<string, JsonObject> = {};
    for (const artifact of artifacts.map(jsonSafeObject)) {
      const artifactId = stringValue(artifact.id);
      if (!artifactId || session.sensitive_artifacts[artifactId] || additions[artifactId]) {
        continue;
      }
      additions[artifactId] = artifact;
    }
    if (!Object.keys(additions).length) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      sensitive_artifacts: {
        ...session.sensitive_artifacts,
        ...additions,
      },
    });
  }

  private recoverInterruptedRuntime(session: CoworkSession): CoworkSession {
    let recovered = false;
    const traceSpans = session.trace_spans.map((span) => {
      const status = stringValue(span.status);
      if (!["pending", "running", "in_progress"].includes(status) || stringValue(span.ended_at)) {
        return span;
      }
      recovered = true;
      return {
        ...span,
        status: "failed",
        ended_at: this.now(),
        error: stringValue(span.error) || "Interrupted before the process stopped.",
        summary: stringValue(span.summary) || "Interrupted runtime span recovered on load.",
      };
    });
    if (!recovered) {
      return session;
    }
    return normalizeCoworkSession({
      ...session,
      trace_spans: traceSpans,
      runtime_state: {
        ...session.runtime_state,
        interrupted_span_recovery_at: this.now(),
      },
    });
  }

  private async requireSession(sessionId: string, traceId: string): Promise<CoworkSession> {
    const session = await this.loadSession(sessionId, traceId);
    if (!session) {
      throw new Error(`cowork session '${sessionId}' not found`);
    }
    return session;
  }

  private ensureThread(session: CoworkSession, threadId: string | undefined, topic: string, participants: string[]): JsonObject {
    const existingId = cleanString(threadId);
    if (existingId && session.threads[existingId]) {
      return session.threads[existingId];
    }
    const id = existingId || this.idGenerator("thread");
    const thread = {
      id,
      topic: topic || "Discussion",
      summary: "",
      participant_ids: unique(participants.filter((participant) => participant === "user" || Boolean(session.agents[participant]))),
      message_ids: [],
      created_at: this.now(),
      updated_at: this.now(),
      last_message_at: null,
    };
    session.threads[id] = thread;
    return thread;
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

  private notifyListeners(session: CoworkSession, event: CoworkEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(session, event);
      } catch {
        // Listener failures must not break Cowork state persistence.
      }
    }
  }

  private traceSpan(
    kind: string,
    name: string,
    options: { sessionId: string; actorId?: string; status?: string; inputRef?: string; summary?: string; data?: JsonObject },
  ): JsonObject {
    return {
      id: this.idGenerator("span"),
      session_id: options.sessionId,
      kind,
      name,
      actor_id: options.actorId ?? null,
      status: options.status ?? "completed",
      started_at: this.now(),
      ended_at: this.now(),
      input_ref: options.inputRef ?? "",
      summary: options.summary ?? "",
      data: options.data ?? {},
    };
  }

  private captureCurrentBranchState(session: CoworkSession): void {
    const branch = currentBranch(session);
    if (!branch) {
      return;
    }
    branch.architecture = normalizeArchitectureName(session.workflow_mode);
    branch.status = session.status;
    branch.completion_decision = jsonSafeObject(session.completion_decision);
    branch.runtime_state = {
      ...jsonSafeObject(branch.runtime_state),
      current_focus_task: session.current_focus_task,
      rounds: session.rounds,
      no_progress_rounds: session.no_progress_rounds,
      stop_reason: session.stop_reason,
    };
    if (branch.status === "completed" && !branch.branch_result) {
      this.recordBranchResult(session, branch);
    }
    branch.updated_at = this.now();
  }

  private recordBranchResult(session: CoworkSession, branch: CoworkBranch): JsonObject {
    if (branch.branch_result) {
      return branch.branch_result;
    }
    const completedTasks = Object.values(session.tasks).filter((task) => task.status === "completed");
    const confidences = completedTasks.map((task) => task.confidence).filter((value): value is number => value !== null);
    const summary = cleanString(session.final_draft) || cleanString(session.shared_summary) || buildFinalDraft(session)
      || `Branch '${branch.title}' completed for goal: ${session.goal}`;
    const result: JsonObject = {
      id: this.idGenerator("brres"),
      source_branch_id: branch.id,
      source_architecture: branch.architecture,
      summary,
      artifacts: session.artifacts.slice(-20),
      decision: Object.keys(jsonSafeObject(session.completion_decision)).length
        ? jsonSafeObject(session.completion_decision)
        : jsonSafeObject(branch.completion_decision),
      confidence: confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      result_type: "branch",
      source_result_ids: [],
      created_at: this.now(),
    };
    branch.branch_result = result;
    session.events = [
      ...session.events,
      this.event("branch.result.created", `Branch '${branch.id}' produced a result`, {
        actorId: "system",
        data: {
          branch_id: branch.id,
          branch_result_id: stringValue(result.id),
          architecture: branch.architecture,
        },
      }),
    ];
    return result;
  }
}

export function createMemoryCoworkStore(seed: CoworkSession[] = []): CoworkServiceStore {
  const sessions = new Map<string, CoworkSession>();
  for (const session of seed) {
    sessions.set(session.id, cloneSession(normalizeCoworkSession(session)));
  }
  return {
    async listSnapshots() {
      return [...sessions.values()].map(cloneSession);
    },
    async readSnapshot(sessionId: string) {
      const session = sessions.get(sessionId);
      return session ? cloneSession(session) : null;
    },
    async writeSnapshot(session: CoworkSession) {
      const normalized = normalizeCoworkSession(session);
      sessions.set(normalized.id, cloneSession(normalized));
      return cloneSession(normalized);
    },
    async deleteSession(sessionId: string) {
      return sessions.delete(sessionId);
    },
    async ensureSessionWorkspace(sessionId: string) {
      return `memory://cowork/${sessionId}`;
    },
  };
}

function defaultTeam(goal: string): CoworkAgentInput[] {
  return [{
    id: "coordinator",
    name: "Coordinator",
    role: "Team coordinator",
    goal: `Keep the collaboration focused on: ${goal}`,
    responsibilities: ["Break down work", "Route questions", "Synthesize final progress"],
    tools: [...DEFAULT_COWORK_AGENT_TOOLS],
    subscriptions: ["coordination", "handoff", "unblock", "decision", "summary"],
  }];
}

function currentBranch(session: CoworkSession) {
  return session.branches[session.current_branch_id || DEFAULT_BRANCH_ID] ?? session.branches[DEFAULT_BRANCH_ID];
}

function findSwarmWorkUnit(session: CoworkSession, workUnitId: string): JsonObject | null {
  const units = Array.isArray(session.swarm_plan.work_units) ? session.swarm_plan.work_units : [];
  return units.find((unit) => isJsonObject(unit) && unit.id === workUnitId) as JsonObject | undefined ?? null;
}

function updateWorkUnitReadiness(planInput: unknown, tasks: Record<string, CoworkTask>, now: () => string): JsonObject {
  const plan = jsonSafeObject(planInput);
  const units = Array.isArray(plan.work_units) ? plan.work_units.filter(isJsonObject).map(jsonSafeObject) : [];
  const completedUnits = new Set(units
    .filter((unit) => unit.status === "completed" || unit.status === "skipped")
    .map((unit) => cleanString(unit.id))
    .filter(Boolean));
  const completedTasks = new Set(Object.values(tasks)
    .filter((task) => task.status === "completed" || task.status === "skipped")
    .map((task) => task.id));
  let changed = false;
  for (const unit of units) {
    if (unit.status !== "pending") {
      continue;
    }
    const dependencies = stringList(unit.dependencies);
    if (dependencies.every((dependency) => completedUnits.has(dependency) || completedTasks.has(dependency))) {
      unit.status = "ready";
      unit.updated_at = now();
      unit.readiness_reason = {
        completed_dependencies: dependencies.sort(),
        priority: intValue(unit.priority),
      };
      changed = true;
    }
  }
  return {
    ...plan,
    work_units: units,
    ...(changed ? { updated_at: now() } : {}),
  };
}

function normalizeBudgetLimits(value: JsonObject): JsonObject {
  const limits: JsonObject = { ...DEFAULT_BUDGET_LIMITS };
  for (const [key, rawValue] of Object.entries(value)) {
    limits[key] = key in DEFAULT_BUDGET_LIMITS ? coerceBudgetValue(rawValue) : rawValue;
  }
  return limits;
}

function coerceBudgetValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(0, Math.trunc(number));
}

function defaultBudgetUsage(): JsonObject {
  return { ...DEFAULT_BUDGET_USAGE };
}

function budgetState(session: CoworkSession): JsonObject {
  const limits = normalizeBudgetLimits(jsonSafeObject(session.budget_limits));
  const usage = {
    ...defaultBudgetUsage(),
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
    const limit = numberOrNull(limits[limitKey]);
    remaining[limitKey] = limit === null ? null : Math.max(0, limit - (numberOrNull(usage[usageKey]) ?? 0));
  }
  return remaining;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deriveFocusTask(tasks: Record<string, CoworkTask>, goal: string): string {
  const ready = Object.values(tasks)
    .filter((task) => task.status === "pending")
    .sort((left, right) => left.id.localeCompare(right.id));
  const task = ready[0];
  if (!task) {
    return goal;
  }
  return `${task.title}: ${task.description}`;
}

function titleizeArchitecture(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function stageContextSummary(session: CoworkSession, source: CoworkBranch): string {
  return [
    session.shared_summary,
    session.final_draft,
    stringValue(source.runtime_state.current_focus_task),
    session.current_focus_task,
  ]
    .map(cleanString)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
}

function stageSourceSummary(session: CoworkSession, source: CoworkBranch): string {
  const result = jsonSafeObject(source.branch_result);
  return cleanString(result.summary)
    || cleanString(session.final_draft)
    || cleanString(session.shared_summary)
    || cleanString(source.runtime_state.current_focus_task)
    || session.goal;
}

function stageMessageRefs(session: CoworkSession): JsonObject[] {
  return Object.values(session.messages)
    .map(jsonSafeObject)
    .slice(-20)
    .map((message) => ({
      id: stringValue(message.id),
      sender_id: stringValue(message.sender_id),
      created_at: stringValue(message.created_at),
      thread_id: stringValue(message.thread_id),
    }));
}

function stageDecisions(session: CoworkSession): JsonObject[] {
  const decision = jsonSafeObject(session.completion_decision);
  return Object.keys(decision).length ? [decision] : [];
}

function buildFinalDraft(session: CoworkSession): string {
  const completed = Object.values(session.tasks)
    .filter((task) => task.status === "completed" && cleanString(task.result))
    .map((task) => `## ${task.title}\n${task.result}`);
  return completed.join("\n\n");
}

function leadAgentId(agents: Record<string, CoworkAgent>): string {
  return Object.keys(agents)[0] ?? "";
}

function reviewerAgentId(value: unknown, agents: Record<string, CoworkAgent>): string {
  const explicit = cleanString(value);
  if (explicit) {
    const id = slug(explicit, "agent");
    if (agents[id]) {
      return id;
    }
  }
  const reviewer = Object.values(agents).find((agent) => {
    const haystack = `${agent.id} ${agent.name} ${agent.role} ${agent.responsibilities.join(" ")}`.toLowerCase();
    return haystack.includes("review") || haystack.includes("verify") || haystack.includes("quality");
  });
  return reviewer?.id ?? leadAgentId(agents);
}

function looksLikeReviewTask(task: CoworkTask): boolean {
  const text = `${task.title} ${task.description}`.toLowerCase();
  return text.includes("review");
}

function agentCurrentTask(session: CoworkSession, agentId: string): JsonObject | null {
  const agent = session.agents[agentId];
  if (agent?.current_task_id && session.tasks[agent.current_task_id]) {
    return taskActivityPayload(session.tasks[agent.current_task_id]);
  }
  const task = Object.values(session.tasks).find((item) => item.assigned_agent_id === agentId && !["completed", "skipped", "failed"].includes(item.status));
  return task ? taskActivityPayload(task) : null;
}

function taskActivityPayload(task: CoworkTask): JsonObject {
  return {
    id: task.id,
    title: task.title,
    description: compact(task.description, 500),
    assigned_agent_id: task.assigned_agent_id,
    status: task.status,
    result: compact(task.result, 700),
    error: compact(task.error, 500),
    review_status: task.review_status,
    updated_at: task.updated_at,
    created_at: task.created_at,
  };
}

function assignmentFor(value: unknown, agents: Record<string, CoworkAgent>): string | null {
  const assigned = cleanString(value);
  if (!assigned) {
    return null;
  }
  const id = slug(assigned, "agent");
  if (agents[id]) {
    return id;
  }
  return Object.keys(agents)[0] ?? null;
}

function assignedAgentIdForMutation(value: unknown, agents: Record<string, CoworkAgent>): string | null {
  const assigned = cleanString(value);
  if (!assigned) {
    return null;
  }
  const id = slug(assigned, "agent");
  return agents[id] ? id : null;
}

function agentTools(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [...DEFAULT_COWORK_AGENT_TOOLS];
  }
  const tools = stringList(value);
  return tools.length > 0 ? unique(tools) : [...DEFAULT_COWORK_AGENT_TOOLS];
}

function agentSubscriptions(raw: JsonObject, id: string): string[] {
  const explicit = stringList(raw.subscriptions);
  const values = explicit.length > 0
    ? explicit
    : [
      id,
      cleanString(raw.role),
      ...stringList(raw.responsibilities),
    ];
  return unique(values.map(subscriptionSlug).filter(Boolean)).slice(0, 12);
}

function slug(value: unknown, fallback = "item"): string {
  const text = cleanString(value).toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text.slice(0, 40) || fallback;
}

function subscriptionSlug(value: unknown): string {
  return cleanString(value).toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function dedupeId(baseId: string, map: Record<string, unknown>): string {
  let id = baseId;
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(map, id)) {
    id = `${baseId}_${counter}`;
    counter += 1;
  }
  return id;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(cleanString).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function jsonObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map(jsonSafeObject);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(80, Math.trunc(parsed)));
}

function compact(value: unknown, limit: number): string {
  const text = cleanString(value).split(/\s+/).filter(Boolean).join(" ");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function intValue(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableString(value: unknown): string | null {
  const text = cleanString(value);
  return text || null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function jsonSafeObject(value: unknown): JsonObject {
  return isJsonObject(value) ? { ...value } : {};
}

function cloneSession(session: CoworkSession): CoworkSession {
  return normalizeCoworkSession(JSON.parse(JSON.stringify(session)) as JsonObject);
}

function cryptoRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
