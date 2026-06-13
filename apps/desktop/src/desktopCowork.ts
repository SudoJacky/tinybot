import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

export type DesktopCoworkSelectionType =
  | "session"
  | "agent"
  | "task"
  | "mailbox"
  | "thread"
  | "trace"
  | "artifact"
  | "workUnit"
  | "branch"
  | "";

export interface DesktopCoworkSelection {
  type: DesktopCoworkSelectionType;
  id: string;
}

export interface DesktopCoworkTaskProgress {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
}

export interface DesktopCoworkAttention {
  total: number;
  blockers: number;
  pendingReplies: number;
  taskIssues: number;
  workUnitIssues: number;
  agentIssues: number;
  approvals: number;
  interventions: number;
  tone: "attention" | "complete" | "normal";
  label: string;
}

export interface DesktopCoworkSessionRow {
  id: string;
  title: string;
  goal: string;
  status: string;
  workflow: string;
  agentCount: number;
  activeAgentCount: number;
  taskProgress: DesktopCoworkTaskProgress;
  attention: DesktopCoworkAttention;
  finalOutput: string;
  updatedAt: string;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkCockpitView {
  header: {
    id: string;
    title: string;
    goal: string;
    status: string;
    workflow: string;
    updatedAt: string;
  };
  agents: DesktopCoworkAgentRow[];
  tasks: DesktopCoworkTaskRow[];
  mailbox: DesktopCoworkMailboxRow[];
  threads: DesktopCoworkThreadRow[];
  trace: DesktopCoworkTraceRow[];
  branches: DesktopCoworkBranchRow[];
  artifacts: DesktopCoworkArtifactRow[];
  workUnits: DesktopCoworkWorkUnitRow[];
  graph: DesktopCoworkGraphView;
  observabilityPanels: DesktopCoworkObservabilityPanel[];
  inspector: DesktopCoworkInspectorView;
  taskCenterItems: DesktopCoworkTaskCenterItem[];
  raw: UnknownRecord;
}

export type DesktopCoworkObservabilityPanelId =
  | "graph"
  | "focus"
  | "metrics"
  | "architecture"
  | "swarm"
  | "workUnits"
  | "taskDag"
  | "agents"
  | "tasks"
  | "mailbox"
  | "threads"
  | "trace"
  | "artifacts"
  | "outputs"
  | "finalDraft"
  | "blockers"
  | "evaluations"
  | "status";

export interface DesktopCoworkObservabilityPanel {
  id: DesktopCoworkObservabilityPanelId;
  label: string;
  summary: string;
  rows: Array<{ label: string; value: string }>;
}

export interface DesktopCoworkAgentRow {
  id: string;
  label: string;
  roleOrTask: string;
  status: string;
  latestActivity: string;
  attention: {
    state: string;
    label: string;
    tone: "attention" | "waiting" | "normal";
  };
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkTaskRow {
  id: string;
  title: string;
  status: string;
  assignedAgentId: string;
  description: string;
  resultText: string;
  confidenceLabel: string;
  availableActions: string[];
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkMailboxRow {
  id: string;
  route: string;
  status: string;
  content: string;
  requiresReply: boolean;
  tone: "attention" | "normal";
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkThreadRow {
  id: string;
  topic: string;
  participants: string[];
  messageCount: number;
  status: string;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkTraceRow {
  id: string;
  stage: string;
  action: string;
  status: string;
  detail: string;
  at: string;
  target: string;
  payloadText: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkBranchRow {
  branchId: string;
  resultId: string;
  title: string;
  status: string;
  selected: boolean;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkArtifactRow {
  id: string;
  title: string;
  kind: string;
  location: string;
  status: string;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkWorkUnitRow {
  id: string;
  title: string;
  status: string;
  assignedAgentId: string;
  resultText: string;
  availableActions: string[];
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopCoworkGraphView {
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    status: string;
    raw: UnknownRecord;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    raw: UnknownRecord;
  }>;
  caption: string;
}

export interface DesktopCoworkInspectorView {
  type: DesktopCoworkSelectionType;
  id: string;
  title: string;
  body: string;
  rows: Array<{ label: string; value: string }>;
  payloadText: string;
  raw: UnknownRecord | null;
}

export interface DesktopCoworkTaskCenterItem {
  id: string;
  title: string;
  status: string;
  tone: "attention" | "complete" | "normal";
  detail: string;
  destination: {
    module: "cowork";
    sessionId: string;
    selection?: DesktopCoworkSelection;
  };
}

export type DesktopCoworkActionRequest =
  | {
      method: "GET" | "DELETE";
      path: string;
    }
  | {
      method: "POST" | "PATCH";
      path: string;
      body?: UnknownRecord;
    };

export type DesktopCoworkActionInput =
  | { action: "listSessions"; includeCompleted?: boolean; originChatId?: string }
  | { action: "loadSession"; sessionId: string }
  | { action: "loadSummary"; sessionId: string }
  | { action: "loadGraph"; sessionId: string }
  | { action: "loadBlueprint"; sessionId: string }
  | { action: "loadTrace"; sessionId: string }
  | { action: "loadDag"; sessionId: string }
  | { action: "loadArtifacts"; sessionId: string }
  | { action: "loadOrganization"; sessionId: string }
  | { action: "loadQueues"; sessionId: string }
  | { action: "loadBranches"; sessionId: string }
  | { action: "loadAgentActivity"; sessionId: string; agentId: string; limit?: number }
  | { action: "loadObservation"; sessionId: string; detailRef: string; requesterAgentId?: string }
  | { action: "createSession"; goal?: string; blueprint?: unknown; architecture?: string; autoRun?: boolean }
  | { action: "runSession"; sessionId: string }
  | { action: "pauseSession" | "resumeSession" | "emergencyStopSession"; sessionId: string }
  | { action: "deleteSession"; sessionId: string }
  | { action: "sendMessage"; sessionId: string; content: string; recipientIds?: string[] }
  | { action: "addTask"; sessionId: string; title: string; assignedAgentId: string }
  | { action: "task"; sessionId: string; taskId: string; taskAction: "assign" | "retry" | "review"; assignedAgentId?: string }
  | { action: "workUnit"; sessionId: string; workUnitId: string; workUnitAction: "retry" | "skip" | "cancel"; reason?: string }
  | { action: "updateBudget"; sessionId: string; body: UnknownRecord }
  | { action: "deriveBranch"; sessionId: string; sourceBranchId?: string | null; body: UnknownRecord }
  | { action: "selectBranch"; sessionId: string; branchId: string }
  | { action: "selectBranchResult"; sessionId: string; branchId: string; resultId: string }
  | { action: "mergeBranchResults"; sessionId: string; branchIds: string[] }
  | { action: "selectFinalResult"; sessionId: string; body: UnknownRecord }
  | { action: "mergeFinalResult"; sessionId: string; body: UnknownRecord }
  | { action: "validateBlueprint"; preview?: boolean; blueprint: unknown };

type UnknownRecord = Record<string, unknown>;

const ACTIVE_SESSION_STATUSES = new Set(["active", "running", "paused", "blocked"]);
const DONE_TASK_STATUSES = new Set(["completed", "done", "reviewed", "accepted"]);
const ACTIVE_WORK_STATUSES = new Set(["active", "running", "working", "in_progress"]);
const ATTENTION_STATUSES = new Set(["blocked", "failed", "error", "needs_revision", "expired", "requires_approval", "approval_required", "approval-needed", "needs_intervention", "needs-intervention", "intervention-needed", "intervention_needed"]);
const APPROVAL_SESSION_STATUSES = new Set(["requires_approval", "approval_required", "approval-needed", "requires-approval"]);
const INTERVENTION_SESSION_STATUSES = new Set(["needs_intervention", "needs-intervention", "intervention-needed", "intervention_needed"]);
const PENDING_REPLY_STATUSES = new Set(["delivered", "read", "pending"]);
const COWORK_CANCELABLE_STATUSES = new Set(["active", "running"]);
const COWORK_RETRYABLE_STATUSES = new Set(["failed", "error"]);
const DEFAULT_RUN_ROUNDS = 20;
const DEFAULT_RUN_AGENTS = 3;
const DEFAULT_RUN_AGENT_CALLS = 30;

export function buildDesktopCoworkSessionRows(payload: unknown): DesktopCoworkSessionRow[] {
  return arrayFromPayload(payload, "items", "sessions").map((session) => buildDesktopCoworkSessionRow(safeSession(session)));
}

export function buildDesktopCoworkCockpitView(
  value: unknown,
  options: { selected?: DesktopCoworkSelection } = {},
): DesktopCoworkCockpitView {
  const session = safeSession(value);
  const row = buildDesktopCoworkSessionRow(session);
  const selection = options.selected ?? { type: "session", id: row.id };
  const agents = buildAgentRows(session);
  const tasks = buildTaskRows(session.tasks);
  const mailbox = buildMailboxRows(session.mailbox);
  const threads = buildThreadRows(session.threads);
  const trace = buildDesktopCoworkTraceRows(session);
  const branches = buildBranchRows(session);
  const artifacts = buildArtifactRows(session);
  const workUnits = buildWorkUnitRows(session);
  const graph = buildDesktopCoworkGraphView(session);
  const taskCenterItems = buildDesktopCoworkTaskCenterItems(session);
  return {
    header: {
      id: row.id,
      title: row.title,
      goal: row.goal,
      status: row.status,
      workflow: row.workflow,
      updatedAt: row.updatedAt,
    },
    agents,
    tasks,
    mailbox,
    threads,
    trace,
    branches,
    artifacts,
    workUnits,
    graph,
    observabilityPanels: buildDesktopCoworkObservabilityPanels(session, {
      row,
      agents,
      tasks,
      mailbox,
      threads,
      trace,
      branches,
      artifacts,
      workUnits,
      graph,
      taskCenterItems,
    }),
    inspector: buildDesktopCoworkInspectorView(session, selection),
    taskCenterItems,
    raw: session,
  };
}

export function buildDesktopCoworkTaskOperations(payload: unknown): DesktopTaskSourceOperation[] {
  return sessionsFromPayload(payload).map(buildDesktopCoworkTaskOperation);
}

export function buildDesktopCoworkTaskOperation(value: unknown): DesktopTaskSourceOperation {
  const session = safeSession(value);
  const row = buildDesktopCoworkSessionRow(session);
  const status = row.status || "active";
  const progress = row.taskProgress.total
    ? { completed: row.taskProgress.completed, total: row.taskProgress.total }
    : undefined;
  return {
    id: `cowork:${row.id}`,
    title: row.title,
    status,
    detail: row.attention.label,
    ...(progress ? { progress } : {}),
    canonical: { module: "cowork", entityId: row.id, href: "/cowork" },
    diagnostics: stringValue(session.error) || stringValue(session.last_error),
    relatedResources: coworkWorkLensResources(session, row.id),
    outputs: coworkWorkLensOutputs(session, row.id),
    retryable: COWORK_RETRYABLE_STATUSES.has(status.toLowerCase()),
    cancelable: COWORK_CANCELABLE_STATUSES.has(status.toLowerCase()),
    updatedAt: row.updatedAt,
  };
}

function coworkWorkLensResources(session: UnknownRecord, sessionId: string) {
  const route = { module: "cowork" as const, entityId: sessionId, href: "/cowork" };
  const taskResources = arrayValue(session.tasks).filter(isRecord).slice(0, 4).map((task, index) => ({
    kind: "coworkEntity" as const,
    id: `cowork:${sessionId}:task:${stringValue(task.id) || index + 1}`,
    title: stringValue(task.title) || stringValue(task.name) || `Task ${index + 1}`,
    detail: [stringValue(task.status), stringValue(task.assigned_agent_id) || stringValue(task.owner)].filter(Boolean).join(" / "),
    route,
  }));
  const workUnitResources = arrayValue(asRecord(session.swarm_plan).work_units).filter(isRecord).slice(0, 4).map((unit, index) => ({
    kind: "coworkEntity" as const,
    id: `cowork:${sessionId}:work-unit:${stringValue(unit.id) || index + 1}`,
    title: stringValue(unit.title) || stringValue(unit.name) || `Work unit ${index + 1}`,
    detail: [stringValue(unit.status), stringValue(unit.assigned_agent_id) || stringValue(unit.owner)].filter(Boolean).join(" / "),
    route,
  }));
  const branchResources = arrayValue(session.branches).filter(isRecord).slice(0, 4).map((branch, index) => ({
    kind: "coworkEntity" as const,
    id: `cowork:${sessionId}:branch:${stringValue(branch.id) || index + 1}`,
    title: stringValue(branch.title) || stringValue(branch.name) || `Branch ${index + 1}`,
    detail: [stringValue(branch.status), stringValue(branch.result_status)].filter(Boolean).join(" / "),
    route,
  }));
  return [...taskResources, ...workUnitResources, ...branchResources];
}

function coworkWorkLensOutputs(session: UnknownRecord, sessionId: string) {
  const route = { module: "cowork" as const, entityId: sessionId, href: "/cowork" };
  const artifactOutputs = arrayValue(session.artifacts).filter(isRecord).slice(0, 4).map((artifact, index) => ({
    kind: "artifact" as const,
    id: `cowork:${sessionId}:artifact:${stringValue(artifact.id) || index + 1}`,
    title: stringValue(artifact.title) || stringValue(artifact.name) || stringValue(artifact.path) || `Artifact ${index + 1}`,
    detail: [stringValue(artifact.kind) || stringValue(artifact.type), stringValue(artifact.status), stringValue(artifact.path)].filter(Boolean).join(" / "),
    route,
  }));
  const finalOutput = coworkFinalOutput(session);
  return finalOutput ? [
    ...artifactOutputs,
    {
      kind: "artifact" as const,
      id: `cowork:${sessionId}:final-output`,
      title: "Final output",
      detail: finalOutput,
      route,
    },
  ] : artifactOutputs;
}

export function buildDesktopCoworkGraphView(value: unknown): DesktopCoworkGraphView {
  const session = safeSession(value);
  const graph = asRecord(session.graph);
  const nodes = arrayFromPayload(graph, "nodes").map((node) => {
    const id = stringValue(node.id);
    return {
      id,
      label: stringValue(node.label) || stringValue(node.title) || stringValue(node.name) || id,
      kind: stringValue(node.kind) || stringValue(node.type) || "node",
      status: stringValue(node.status),
      raw: node,
    };
  });
  const edges = arrayFromPayload(graph, "edges").map((edge, index) => ({
    id: stringValue(edge.id) || `${stringValue(edge.source)}:${stringValue(edge.target)}:${index}`,
    source: stringValue(edge.source),
    target: stringValue(edge.target),
    label: stringValue(edge.label) || stringValue(edge.kind) || stringValue(edge.type),
    raw: edge,
  }));
  return {
    nodes,
    edges,
    caption: `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} / ${edges.length} ${edges.length === 1 ? "edge" : "edge"}`,
  };
}

export function buildDesktopCoworkTraceRows(value: unknown): DesktopCoworkTraceRow[] {
  const session = safeSession(value);
  const sessionTrace = arrayValue(session.trace).filter(isRecord);
  const trace = sessionTrace.length ? sessionTrace : arrayValue(session.trace_spans).filter(isRecord);
  return trace.map((item, index) => {
    const id = stringValue(item.id) || stringValue(item.span_id) || `trace-${index}`;
    return {
      id,
      stage: stringValue(item.stage) || stringValue(item.kind),
      action: stringValue(item.action) || stringValue(item.name) || "event",
      status: stringValue(item.status) || "active",
      detail: stringValue(item.detail) || stringValue(item.summary) || stringValue(item.message),
      at: stringValue(item.at) || stringValue(item.timestamp) || stringValue(item.created_at),
      target: stringValue(item.target) || stringValue(item.agent_id) || stringValue(item.task_id),
      payloadText: stringifyPayload(pick(item, "payload", "data", "result_data")),
      raw: item,
    };
  });
}

export function buildDesktopCoworkActionRequest(input: DesktopCoworkActionInput): DesktopCoworkActionRequest {
  switch (input.action) {
    case "listSessions": {
      const params = new URLSearchParams();
      if (input.includeCompleted) {
        params.set("include_completed", "true");
      }
      if (input.originChatId) {
        params.set("origin_chat_id", input.originChatId);
      }
      return { method: "GET", path: `/api/cowork/sessions${params.toString() ? `?${params}` : ""}` };
    }
    case "loadSession":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}` };
    case "loadSummary":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/summary` };
    case "loadGraph":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/graph` };
    case "loadBlueprint":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/blueprint` };
    case "loadTrace":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/trace` };
    case "loadDag":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/dag` };
    case "loadArtifacts":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/artifacts` };
    case "loadOrganization":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/organization` };
    case "loadQueues":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/queues` };
    case "loadBranches":
      return { method: "GET", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branches` };
    case "loadAgentActivity": {
      const params = new URLSearchParams();
      if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
        params.set("limit", String(input.limit));
      }
      return {
        method: "GET",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/agents/${encodePathSegment(input.agentId)}/activity${params.toString() ? `?${params}` : ""}`,
      };
    }
    case "loadObservation":
      const params = new URLSearchParams();
      if (input.requesterAgentId) {
        params.set("agent_id", input.requesterAgentId);
      }
      return {
        method: "GET",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/observations/${encodePathSegment(input.detailRef)}${params.toString() ? `?${params}` : ""}`,
      };
    case "createSession": {
      const architecture = coworkArchitectureValue(input.architecture);
      return {
        method: "POST",
        path: "/api/cowork/sessions",
        body: {
          goal: stringValue(input.goal).trim(),
          blueprint: input.blueprint ?? null,
          architecture,
          workflow_mode: architecture,
          auto_run: input.autoRun ?? true,
          max_rounds: DEFAULT_RUN_ROUNDS,
          max_agents: DEFAULT_RUN_AGENTS,
          max_agent_calls: DEFAULT_RUN_AGENT_CALLS,
          run_until_idle: true,
        },
      };
    }
    case "runSession":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/run`,
        body: {
          max_rounds: DEFAULT_RUN_ROUNDS,
          max_agents: DEFAULT_RUN_AGENTS,
          max_agent_calls: DEFAULT_RUN_AGENT_CALLS,
          run_until_idle: true,
          stop_on_blocker: false,
        },
      };
    case "pauseSession":
      return { method: "POST", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/pause` };
    case "resumeSession":
      return { method: "POST", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/resume` };
    case "emergencyStopSession":
      return { method: "POST", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/emergency-stop` };
    case "deleteSession":
      return { method: "DELETE", path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}` };
    case "sendMessage":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/messages`,
        body: { content: stringValue(input.content).trim(), recipient_ids: input.recipientIds ?? [] },
      };
    case "addTask":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/tasks`,
        body: { title: stringValue(input.title).trim(), assigned_agent_id: input.assignedAgentId },
      };
    case "task": {
      const body = input.taskAction === "assign" ? { assigned_agent_id: input.assignedAgentId ?? "" } : {};
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/tasks/${encodePathSegment(input.taskId)}/${input.taskAction}`,
        body,
      };
    }
    case "workUnit":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/work-units/${encodePathSegment(input.workUnitId)}/${input.workUnitAction}`,
        body: { reason: input.reason ?? `${input.workUnitAction} from desktop` },
      };
    case "updateBudget":
      return {
        method: "PATCH",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/budget`,
        body: input.body,
      };
    case "deriveBranch":
      return {
        method: "POST",
        path: input.sourceBranchId
          ? `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branches/${encodePathSegment(input.sourceBranchId)}/derive`
          : `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branches/derive`,
        body: input.body,
      };
    case "selectBranch":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branches/${encodePathSegment(input.branchId)}/select`,
      };
    case "selectBranchResult":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branches/${encodePathSegment(input.branchId)}/result/select-final`,
        body: { result_id: input.resultId },
      };
    case "mergeBranchResults":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/branch-results/merge`,
        body: { branch_ids: input.branchIds },
      };
    case "selectFinalResult":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/final-result/select`,
        body: input.body,
      };
    case "mergeFinalResult":
      return {
        method: "POST",
        path: `/api/cowork/sessions/${encodePathSegment(input.sessionId)}/final-result/merge`,
        body: input.body,
      };
    case "validateBlueprint":
      return {
        method: "POST",
        path: `/api/cowork/blueprints/${input.preview ? "preview" : "validate"}`,
        body: { blueprint: input.blueprint },
      };
  }
}

function buildDesktopCoworkSessionRow(session: UnknownRecord): DesktopCoworkSessionRow {
  const id = stringValue(session.id);
  const taskProgress = summarizeCoworkTasks(session);
  const attention = summarizeCoworkAttention(session);
  const workflow = coworkArchitectureLabel(stringValue(session.architecture) || stringValue(session.workflow_mode));
  const agents = arrayValue(session.agents).filter(isRecord);
  const activeAgentCount = ACTIVE_SESSION_STATUSES.has(stringValue(session.status).toLowerCase())
    ? agents.filter((agent) => ACTIVE_WORK_STATUSES.has((stringValue(agent.status) || stringValue(agent.lifecycle_status)).toLowerCase())).length
    : 0;
  return {
    id,
    title: stringValue(session.title) || stringValue(session.goal) || id || "Cowork session",
    goal: stringValue(session.goal),
    status: stringValue(session.status) || "active",
    workflow,
    agentCount: agents.length,
    activeAgentCount,
    taskProgress,
    attention,
    finalOutput: coworkFinalOutput(session),
    updatedAt: stringValue(session.updated_at) || stringValue(session.created_at),
    meta: [
      stringValue(session.status) || "active",
      workflow,
      `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
      `${taskProgress.completed}/${taskProgress.total} tasks`,
      attention.total ? `${attention.total} attention` : "",
    ].filter(Boolean).join(" / "),
    raw: session,
  };
}

function buildAgentRows(session: UnknownRecord): DesktopCoworkAgentRow[] {
  return arrayValue(session.agents).filter(isRecord).map((agent, index) => {
    const id = stringValue(agent.id);
    const task = findById(session.tasks, stringValue(agent.current_task_id));
    const status = stringValue(agent.status) || stringValue(agent.lifecycle_status) || "idle";
    const roleOrTask = stringValue(agent.current_task_title) || stringValue(task?.title) || stringValue(agent.goal) || stringValue(agent.role) || "Waiting for work";
    const latest = latestAgentActivity(session, agent);
    const attention = deriveAgentAttention(session, agent);
    return {
      id,
      label: agentDisplayLabel(agent, index),
      roleOrTask,
      status,
      latestActivity: latest,
      attention,
      meta: [stringValue(agent.role) || "Agent", roleOrTask, latest, attention.label].filter(Boolean).join(" / "),
      raw: agent,
    };
  });
}

function buildTaskRows(tasks: unknown): DesktopCoworkTaskRow[] {
  return arrayValue(tasks).filter(isRecord).map((task) => {
    const resultText = stringValue(asRecord(task.result_data).answer) || stringValue(task.result) || stringValue(task.description);
    const confidence = numberValue(task.confidence);
    return {
      id: stringValue(task.id),
      title: stringValue(task.title) || stringValue(task.id),
      status: stringValue(task.status) || "pending",
      assignedAgentId: stringValue(task.assigned_agent_id),
      description: stringValue(task.description),
      resultText,
      confidenceLabel: confidence === null ? "" : `Confidence ${Math.round(confidence * 100)}%`,
      availableActions: taskActions(task),
      meta: [
        `Owner ${stringValue(task.assigned_agent_id) || "-"}`,
        confidence === null ? "" : `Confidence ${Math.round(confidence * 100)}%`,
        arrayValue(task.dependencies).length ? `Depends ${arrayValue(task.dependencies).join(", ")}` : "",
      ].filter(Boolean).join(" / "),
      raw: task,
    };
  });
}

function buildMailboxRows(records: unknown): DesktopCoworkMailboxRow[] {
  return arrayValue(records)
    .filter(isRecord)
    .sort((a, b) => stringValue(b.updated_at || b.created_at).localeCompare(stringValue(a.updated_at || a.created_at)))
    .map((record) => {
      const recipients = arrayValue(record.recipient_ids).map((item) => stringValue(item)).filter(Boolean);
      const requiresReply = record.requires_reply === true;
      return {
        id: stringValue(record.id),
        route: `${stringValue(record.sender_id) || "sender"} -> ${recipients.join(", ") || "none"}`,
        status: stringValue(record.status) || "queued",
        content: stringValue(record.content),
        requiresReply,
        tone: requiresReply ? "attention" : "normal",
        meta: [stringValue(record.kind) || "message", requiresReply ? "reply required" : "", stringValue(record.priority) ? `priority ${record.priority}` : ""]
          .filter(Boolean)
          .join(" / "),
        raw: record,
      };
    });
}

function buildThreadRows(threads: unknown): DesktopCoworkThreadRow[] {
  return arrayValue(threads).filter(isRecord).map((thread) => {
    const participants = arrayValue(thread.participant_ids).map((item) => stringValue(item)).filter(Boolean);
    return {
      id: stringValue(thread.id),
      topic: stringValue(thread.topic) || stringValue(thread.id),
      participants,
      messageCount: numberValue(thread.message_count) ?? 0,
      status: stringValue(thread.status) || "topic",
      meta: [`${numberValue(thread.message_count) ?? 0} msgs`, participants.join(", "), stringValue(thread.last_message_at)].filter(Boolean).join(" / "),
      raw: thread,
    };
  });
}

function buildBranchRows(session: UnknownRecord): DesktopCoworkBranchRow[] {
  const activeBranchId = stringValue(session.active_branch_id) || stringValue(asRecord(session.session_final_result).branch_id);
  return arrayValue(session.branch_results).filter(isRecord).map((branch) => {
    const branchId = stringValue(branch.branch_id) || stringValue(branch.id);
    const resultId = stringValue(branch.result_id) || stringValue(branch.selected_result_id);
    return {
      branchId,
      resultId,
      title: stringValue(branch.title) || stringValue(branch.summary) || branchId,
      status: stringValue(branch.status) || "ready",
      selected: Boolean(activeBranchId && activeBranchId === branchId),
      meta: [stringValue(branch.status) || "ready", resultId ? `Result ${resultId}` : ""].filter(Boolean).join(" / "),
      raw: branch,
    };
  });
}

function buildArtifactRows(session: UnknownRecord): DesktopCoworkArtifactRow[] {
  const artifactIndex = arrayValue(session.artifact_index).filter(isRecord);
  const artifacts = artifactIndex.length ? artifactIndex : arrayValue(session.artifacts).filter(isRecord);
  return arrayValue(artifacts).filter(isRecord).map((artifact, index) => {
    const id = stringValue(artifact.id) || stringValue(artifact.path_or_url) || `artifact-${index}`;
    const kind = stringValue(artifact.kind) || "file";
    const title = stringValue(artifact.summary) || stringValue(artifact.title) || stringValue(artifact.path_or_url) || id;
    return {
      id,
      title,
      kind,
      location: stringValue(artifact.path_or_url) || stringValue(artifact.url) || stringValue(artifact.path),
      status: stringValue(artifact.status),
      meta: [
        kind,
        stringValue(artifact.source_task_id) ? `Task ${artifact.source_task_id}` : "",
        stringValue(artifact.source_agent_id) ? `Agent ${artifact.source_agent_id}` : "",
        stringValue(artifact.status) ? `Status ${artifact.status}` : "",
      ].filter(Boolean).join(" / "),
      raw: artifact,
    };
  });
}

function buildWorkUnitRows(session: UnknownRecord): DesktopCoworkWorkUnitRow[] {
  return arrayValue(asRecord(session.swarm_plan).work_units).filter(isRecord).map((unit) => {
    const status = stringValue(unit.status) || "pending";
    return {
      id: stringValue(unit.id),
      title: stringValue(unit.title) || stringValue(unit.id),
      status,
      assignedAgentId: stringValue(unit.assigned_agent_id),
      resultText: stringValue(asRecord(unit.result).answer) || stringValue(unit.error) || stringValue(unit.description),
      availableActions: workUnitActions(unit),
      meta: [
        stringValue(unit.assigned_agent_id) ? `Agent ${unit.assigned_agent_id}` : "",
        stringValue(unit.kind),
        stringValue(unit.replan_reason),
      ].filter(Boolean).join(" / "),
      raw: unit,
    };
  });
}

function buildDesktopCoworkInspectorView(session: UnknownRecord, selection: DesktopCoworkSelection): DesktopCoworkInspectorView {
  const found = findSelected(session, selection);
  if (!found) {
    return { type: "", id: "", title: "Nothing selected", body: "", rows: [], payloadText: "", raw: null };
  }
  const item = found.item;
  return {
    type: found.type,
    id: found.id,
    title: stringValue(item.title) || stringValue(item.name) || stringValue(item.summary) || stringValue(item.id) || found.type,
    body: stringValue(item.detail) || stringValue(item.description) || stringValue(item.summary) || stringValue(item.result) || stringValue(item.content) || stringValue(item.goal) || stringValue(item.error),
    rows: [
      { label: "Status", value: stringValue(item.status) || stringValue(item.kind) || "-" },
      { label: "Owner", value: stringValue(item.assigned_agent_id) || stringValue(item.owner) || stringValue(item.actor_id) || stringValue(item.source_agent_id) || "-" },
      { label: "Updated", value: stringValue(item.updated_at) || stringValue(item.ended_at) || stringValue(item.created_at) || stringValue(item.started_at) || "-" },
    ],
    payloadText: stringifyPayload(pick(item, "data", "result_data", "payload")),
    raw: item,
  };
}

function buildDesktopCoworkTaskCenterItems(session: UnknownRecord): DesktopCoworkTaskCenterItem[] {
  const row = buildDesktopCoworkSessionRow(session);
  return [{
    id: `cowork:${row.id}`,
    title: row.title,
    status: row.status,
    tone: row.attention.tone,
    detail: row.attention.label,
    destination: {
      module: "cowork",
      sessionId: row.id,
    },
  }];
}

function buildDesktopCoworkObservabilityPanels(
  session: UnknownRecord,
  projection: {
    row: DesktopCoworkSessionRow;
    agents: DesktopCoworkAgentRow[];
    tasks: DesktopCoworkTaskRow[];
    mailbox: DesktopCoworkMailboxRow[];
    threads: DesktopCoworkThreadRow[];
    trace: DesktopCoworkTraceRow[];
    branches: DesktopCoworkBranchRow[];
    artifacts: DesktopCoworkArtifactRow[];
    workUnits: DesktopCoworkWorkUnitRow[];
    graph: DesktopCoworkGraphView;
    taskCenterItems: DesktopCoworkTaskCenterItem[];
  },
): DesktopCoworkObservabilityPanel[] {
  const decision = asRecord(session.completion_decision);
  const architecture = asRecord(session.architecture_projection);
  const swarmPlan = asRecord(session.swarm_plan);
  const taskDag = asRecord(session.task_dag);
  const outputs = arrayValue(session.outputs).filter(isRecord);
  const blockers = [
    ...arrayValue(decision.blocked),
    ...arrayValue(decision.review_blockers),
    ...arrayValue(decision.fanout_blockers),
    ...arrayValue(decision.disagreements),
  ].filter(isRecord);
  const evaluations = arrayValue(session.evaluation_results).filter(isRecord);
  const finalDraft = coworkFinalOutput(session);
  const metrics = arrayValue(session.run_metrics).filter(isRecord);

  return [
    panel("graph", "Graph", projection.graph.caption, [
      ...projection.graph.nodes.map((node) => ({ label: "Node", value: [node.label, node.kind, node.status].filter(Boolean).join(" / ") })),
      ...projection.graph.edges.map((edge) => ({ label: "Edge", value: `${edge.source} -> ${edge.target}${edge.label ? ` / ${edge.label}` : ""}` })),
    ]),
    panel("focus", "Focus strip", `${projection.row.activeAgentCount}/${projection.row.agentCount} active agents`, [
      ...projection.agents.map((agent) => ({ label: agent.label, value: [agent.status, agent.roleOrTask, agent.attention.label].filter(Boolean).join(" / ") })),
      { label: "Attention", value: projection.row.attention.label },
    ]),
    panel("metrics", "Run metrics", `${metrics.length} metric${metrics.length === 1 ? "" : "s"}`, metrics.map((metric, index) => ({
      label: stringValue(metric.label) || stringValue(metric.name) || stringValue(metric.key) || `Metric ${index + 1}`,
      value: firstNonEmpty(stringValue(metric.value), stringValue(metric.count), stringValue(metric.status), stringifyPayload(metric)),
    }))),
    panel("architecture", "Architecture projection", firstNonEmpty(stringValue(architecture.summary), projection.row.workflow), [
      { label: "Projection", value: firstNonEmpty(stringValue(architecture.summary), projection.row.workflow) },
      ...arrayValue(architecture.sections).filter(isRecord).map((section) => ({
        label: stringValue(section.title) || stringValue(section.name) || "Section",
        value: [stringValue(section.status), stringValue(section.summary), stringValue(section.description)].filter(Boolean).join(" / "),
      })),
    ]),
    panel("swarm", "Swarm plan", firstNonEmpty(stringValue(swarmPlan.summary), `${projection.workUnits.length} work unit(s)`), [
      { label: "Plan", value: firstNonEmpty(stringValue(swarmPlan.summary), stringifyPayload(pick(swarmPlan, "strategy", "goal", "mode"))) },
      ...projection.branches.map((branch) => ({ label: "Branch", value: `${branch.title}: ${branch.meta}` })),
    ]),
    panel("workUnits", "Work units", `${projection.workUnits.length} work unit(s)`, projection.workUnits.map((unit) => ({
      label: unit.id || unit.title,
      value: [unit.title, unit.status, unit.assignedAgentId, unit.resultText].filter(Boolean).join(" / "),
    }))),
    panel("taskDag", "Task DAG", `${arrayValue(taskDag.nodes).length} nodes / ${arrayValue(taskDag.edges).length} edges`, [
      ...arrayValue(taskDag.nodes).filter(isRecord).map((node) => ({
        label: "Node",
        value: firstNonEmpty(stringValue(node.label), stringValue(node.title), stringValue(node.id)),
      })),
      ...arrayValue(taskDag.edges).filter(isRecord).map((edge) => ({
        label: "Edge",
        value: `${stringValue(edge.source)} -> ${stringValue(edge.target)}${stringValue(edge.label) ? ` / ${edge.label}` : ""}`,
      })),
    ]),
    panel("agents", "Agents", `${projection.agents.length} agent(s)`, projection.agents.map((agent) => ({
      label: agent.label,
      value: agent.meta || agent.status,
    }))),
    panel("tasks", "Tasks", `${projection.tasks.length} task(s)`, projection.tasks.map((task) => ({
      label: task.title,
      value: [task.status, task.meta, task.resultText].filter(Boolean).join(" / "),
    }))),
    panel("mailbox", "Mailbox", `${projection.mailbox.length} message(s)`, projection.mailbox.map((item) => ({
      label: item.route,
      value: [item.status, item.content, item.meta].filter(Boolean).join(" / "),
    }))),
    panel("threads", "Threads", `${projection.threads.length} thread(s)`, projection.threads.map((thread) => ({
      label: thread.topic,
      value: thread.meta,
    }))),
    panel("trace", "Trace", `${projection.trace.length} span(s)`, projection.trace.map((span) => ({
      label: span.stage || span.action,
      value: [span.action, span.status, span.detail, span.at].filter(Boolean).join(" / "),
    }))),
    panel("artifacts", "Artifacts", `${projection.artifacts.length} artifact(s)`, projection.artifacts.map((artifact) => ({
      label: artifact.title,
      value: [artifact.kind, artifact.location, artifact.status].filter(Boolean).join(" / "),
    }))),
    panel("outputs", "Outputs", `${outputs.length} output(s)`, outputs.map((output, index) => ({
      label: stringValue(output.title) || stringValue(output.id) || `Output ${index + 1}`,
      value: firstNonEmpty(stringValue(output.content), stringValue(output.summary), stringifyPayload(output)),
    }))),
    panel("finalDraft", "Final draft", finalDraft ? "Final draft ready" : "No final draft", [
      { label: "Draft", value: finalDraft || "No final draft" },
    ]),
    panel("blockers", "Blockers", `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`, blockers.map((blocker, index) => ({
      label: stringValue(blocker.id) || stringValue(blocker.request_type) || `Blocker ${index + 1}`,
      value: firstNonEmpty(stringValue(blocker.content), stringValue(blocker.summary), stringValue(blocker.reason), stringifyPayload(blocker)),
    }))),
    panel("evaluations", "Evaluations", `${evaluations.length} evaluation(s)`, evaluations.map((evaluation, index) => ({
      label: stringValue(evaluation.id) || stringValue(evaluation.name) || `Evaluation ${index + 1}`,
      value: [
        stringValue(evaluation.status),
        numberValue(evaluation.score) === null ? "" : `score ${numberValue(evaluation.score)}`,
        stringValue(evaluation.summary),
      ].filter(Boolean).join(" / "),
    }))),
    panel("status", "Status feed", `${projection.taskCenterItems.length} status item(s)`, [
      { label: "Session", value: `${projection.row.status} / ${projection.row.meta}` },
      ...projection.taskCenterItems.map((item) => ({ label: item.title, value: `${item.status} / ${item.detail}` })),
    ]),
  ];
}

function panel(
  id: DesktopCoworkObservabilityPanelId,
  label: string,
  summary: string,
  rows: Array<{ label: string; value: string }>,
): DesktopCoworkObservabilityPanel {
  return {
    id,
    label,
    summary,
    rows: rows.filter((row) => row.value),
  };
}

function summarizeCoworkTasks(session: UnknownRecord): DesktopCoworkTaskProgress {
  const tasks = arrayValue(session.tasks).filter(isRecord);
  return {
    total: tasks.length,
    completed: tasks.filter((task) => DONE_TASK_STATUSES.has(stringValue(task.status).toLowerCase())).length,
    failed: tasks.filter((task) => stringValue(task.status).toLowerCase() === "failed").length,
    blocked: tasks.filter((task) => stringValue(task.status).toLowerCase() === "blocked").length,
  };
}

function summarizeCoworkAttention(session: UnknownRecord): DesktopCoworkAttention {
  const decision = asRecord(session.completion_decision);
  const blockers = [
    ...arrayValue(decision.blocked),
    ...arrayValue(decision.review_blockers),
    ...arrayValue(decision.fanout_blockers),
    ...arrayValue(decision.disagreements),
  ];
  const taskIssues = arrayValue(session.tasks).filter((task) => isRecord(task) && ATTENTION_STATUSES.has(stringValue(task.status).toLowerCase()));
  const workUnitIssues = arrayValue(asRecord(session.swarm_plan).work_units)
    .filter((unit) => isRecord(unit) && ATTENTION_STATUSES.has(stringValue(unit.status).toLowerCase()));
  const agentIssues = arrayValue(session.agents)
    .filter((agent) => isRecord(agent) && ATTENTION_STATUSES.has((stringValue(agent.status) || stringValue(agent.lifecycle_status)).toLowerCase()));
  const sessionStatus = stringValue(session.status).toLowerCase();
  const approvals = [
    ...arrayValue(session.pending_approvals),
    ...arrayValue(session.approval_requests),
    ...arrayValue(session.approvals),
  ].filter((record) => !isRecord(record) || !["completed", "approved", "rejected", "canceled", "cancelled"].includes(stringValue(record.status).toLowerCase()));
  const interventions = [
    ...arrayValue(session.pending_interventions),
    ...arrayValue(session.intervention_requests),
    ...arrayValue(session.interventions),
    ...arrayValue(session.human_interventions),
  ].filter((record) => !isRecord(record) || !["completed", "resolved", "canceled", "cancelled"].includes(stringValue(record.status).toLowerCase()));
  const pendingReplies = arrayValue(session.mailbox).filter((record) => {
    if (!isRecord(record) || record.requires_reply !== true) {
      return false;
    }
    const status = stringValue(record.status).toLowerCase();
    return !status || PENDING_REPLY_STATUSES.has(status);
  });
  const explicitAttention = blockers.length + taskIssues.length + workUnitIssues.length + agentIssues.length + approvals.length + interventions.length + pendingReplies.length;
  if (!explicitAttention && APPROVAL_SESSION_STATUSES.has(sessionStatus)) {
    approvals.push(sessionStatus);
  }
  if (!explicitAttention && !approvals.length && INTERVENTION_SESSION_STATUSES.has(sessionStatus)) {
    interventions.push(sessionStatus);
  }
  const total = blockers.length + taskIssues.length + workUnitIssues.length + agentIssues.length + approvals.length + interventions.length + pendingReplies.length;
  const finalOutput = coworkFinalOutput(session);
  return {
    total,
    blockers: blockers.length,
    pendingReplies: pendingReplies.length,
    taskIssues: taskIssues.length,
    workUnitIssues: workUnitIssues.length,
    agentIssues: agentIssues.length,
    approvals: approvals.length,
    interventions: interventions.length,
    tone: total ? "attention" : finalOutput ? "complete" : "normal",
    label: blockers.length
      ? `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`
      : approvals.length
        ? `${approvals.length} approval${approvals.length === 1 ? "" : "s"} needed`
        : interventions.length
          ? `${interventions.length} intervention${interventions.length === 1 ? "" : "s"} needed`
      : pendingReplies.length
        ? `${pendingReplies.length} ${pendingReplies.length === 1 ? "reply" : "replies"} needed`
        : total
          ? `${total} item${total === 1 ? "" : "s"} need attention`
          : finalOutput
            ? "Final output ready"
            : "No attention needed",
  };
}

function coworkFinalOutput(session: UnknownRecord): string {
  const decision = asRecord(session.completion_decision);
  const sessionFinalResult = asRecord(session.session_final_result);
  return (stringValue(session.final_draft) || stringValue(sessionFinalResult.summary) || stringValue(decision.final_output) || stringValue(decision.final_answer)).trim();
}

function deriveAgentAttention(session: UnknownRecord, agent: UnknownRecord): DesktopCoworkAgentRow["attention"] {
  const status = (stringValue(agent.status) || stringValue(agent.lifecycle_status)).toLowerCase();
  if (ATTENTION_STATUSES.has(status)) {
    return { state: status, label: status.replace(/_/g, " "), tone: "attention" };
  }
  if (numberValue(agent.pending_reply_count) && (numberValue(agent.pending_reply_count) ?? 0) > 0) {
    return { state: "reply_needed", label: "reply needed", tone: "attention" };
  }
  const waitingReply = arrayValue(session.mailbox).find((record) => {
    if (!isRecord(record) || record.requires_reply !== true) {
      return false;
    }
    return arrayValue(record.recipient_ids).map((item) => stringValue(item)).includes(stringValue(agent.id));
  });
  if (waitingReply) {
    return { state: "reply_needed", label: "reply needed", tone: "attention" };
  }
  if (["waiting", "paused", "idle"].includes(status)) {
    return { state: status || "waiting", label: status || "waiting", tone: "waiting" };
  }
  return { state: "normal", label: "", tone: "normal" };
}

function latestAgentActivity(session: UnknownRecord, agent: UnknownRecord): string {
  const latestStep = [...arrayValue(session.agent_steps).filter(isRecord)]
    .reverse()
    .find((step) => stringValue(step.agent_id) === stringValue(agent.id));
  return stringValue(latestStep?.action_kind) || stringValue(latestStep?.status) || (stringValue(agent.last_active_at) ? `active ${agent.last_active_at}` : "waiting");
}

function taskActions(task: UnknownRecord): string[] {
  const status = stringValue(task.status).toLowerCase();
  return [
    "assign",
    ["failed", "blocked", "skipped"].includes(status) ? "retry" : "",
    "review",
  ].filter(Boolean);
}

function workUnitActions(unit: UnknownRecord): string[] {
  const status = stringValue(unit.status).toLowerCase();
  return [
    ["failed", "needs_revision"].includes(status) ? "retry" : "",
    ["failed", "blocked", "pending", "ready", "needs_revision"].includes(status) ? "skip" : "",
    ["pending", "ready", "in_progress", "failed", "needs_revision"].includes(status) ? "cancel" : "",
  ].filter(Boolean);
}

function findSelected(session: UnknownRecord, selection: DesktopCoworkSelection): { type: DesktopCoworkSelectionType; id: string; item: UnknownRecord } | null {
  if (selection.type === "session" || !selection.type) {
    return { type: "session", id: stringValue(session.id), item: session };
  }
  const pools: Record<string, unknown[]> = {
    agent: arrayValue(session.agents),
    task: arrayValue(session.tasks),
    mailbox: arrayValue(session.mailbox),
    thread: arrayValue(session.threads),
    trace: arrayValue(session.trace).length ? arrayValue(session.trace) : arrayValue(session.trace_spans),
    artifact: arrayValue(session.artifact_index).length ? arrayValue(session.artifact_index) : arrayValue(session.artifacts),
    workUnit: arrayValue(asRecord(session.swarm_plan).work_units),
    branch: arrayValue(session.branch_results),
  };
  const item = arrayValue(pools[selection.type]).filter(isRecord).find((candidate) => {
    const ids = [
      candidate.id,
      candidate.branch_id,
      candidate.result_id,
      candidate.path_or_url,
      candidate.span_id,
    ].map((value) => stringValue(value));
    return ids.includes(selection.id);
  });
  return item ? { type: selection.type, id: selection.id, item } : null;
}

function safeSession(value: unknown): UnknownRecord {
  const session = asRecord(value);
  return {
    ...session,
    agents: arrayValue(session.agents).filter(isRecord),
    tasks: arrayValue(session.tasks).filter(isRecord),
    threads: arrayValue(session.threads).filter(isRecord),
    messages: arrayValue(session.messages).filter(isRecord),
    mailbox: arrayValue(session.mailbox).filter(isRecord),
    events: arrayValue(session.events).filter(isRecord),
    trace: arrayValue(session.trace).filter(isRecord),
    trace_spans: arrayValue(session.trace_spans).filter(isRecord),
    agent_steps: arrayValue(session.agent_steps).filter(isRecord),
    branch_results: arrayValue(session.branch_results).filter(isRecord),
    session_final_result: asRecord(session.session_final_result),
    artifact_index: arrayValue(session.artifact_index).filter(isRecord),
    artifacts: arrayValue(session.artifacts).filter(isRecord),
    scheduler_decisions: arrayValue(session.scheduler_decisions).filter(isRecord),
    run_metrics: arrayValue(session.run_metrics).filter(isRecord),
    evaluation_results: arrayValue(session.evaluation_results).filter(isRecord),
    completion_decision: asRecord(session.completion_decision),
    budget_state: asRecord(session.budget_state) || asRecord(session.budget),
    graph: asRecord(session.graph),
    blueprint: asRecord(session.blueprint),
    swarm_plan: asRecord(session.swarm_plan),
    swarm_queues: asRecord(session.swarm_queues),
    swarm_organization: asRecord(session.swarm_organization),
    large_swarm_summary: asRecord(session.large_swarm_summary),
  };
}

function coworkArchitectureValue(value: unknown = ""): string {
  const architecture = stringValue(value) || "adaptive_starter";
  return architecture === "hybrid" ? "adaptive_starter" : architecture;
}

function coworkArchitectureLabel(value: unknown = ""): string {
  const labels: Record<string, string> = {
    adaptive_starter: "Adaptive Starter",
    orchestrator: "Orchestrator",
    supervisor: "Supervisor",
    team: "Agent Team",
    generator_verifier: "Generator-Verifier",
    message_bus: "Message Bus",
    shared_state: "Shared State",
    peer_handoff: "Peer Handoff",
    swarm: "Swarm",
  };
  const architecture = coworkArchitectureValue(value);
  return labels[architecture] || architecture.replace(/_/g, " ");
}

function agentDisplayLabel(agent: UnknownRecord, index = 0): string {
  const name = stringValue(agent.name).trim();
  if (name) {
    return name;
  }
  const role = stringValue(agent.role).trim();
  return role ? `${role} ${index + 1}` : `Agent ${index + 1}`;
}

function findById(items: unknown, id: string): UnknownRecord | null {
  return arrayValue(items).filter(isRecord).find((item) => stringValue(item.id) === id) ?? null;
}

function stringifyPayload(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim()) ?? "";
}

function arrayFromPayload(payload: unknown, ...keys: string[]): UnknownRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const record = asRecord(payload);
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function sessionsFromPayload(payload: unknown): UnknownRecord[] {
  const sessions = arrayFromPayload(payload, "items", "sessions");
  if (sessions.length) {
    return sessions;
  }
  const record = asRecord(payload);
  return stringValue(record.id) ? [record] : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
