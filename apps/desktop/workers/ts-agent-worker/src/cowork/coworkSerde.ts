import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { CoworkAgent, CoworkBranch, CoworkEvent, CoworkSession, CoworkStore, CoworkTask } from "./coworkTypes.ts";

const ADAPTIVE_STARTER = "adaptive_starter";
const DEFAULT_BRANCH_ID = "default";
const SHARED_MEMORY_BUCKETS = ["findings", "claims", "risks", "open_questions", "decisions", "artifacts"] as const;
const CANONICAL_ARCHITECTURES = new Set([
  ADAPTIVE_STARTER,
  "supervisor",
  "orchestrator",
  "team",
  "generator_verifier",
  "message_bus",
  "shared_state",
  "peer_handoff",
  "swarm",
]);

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

export function normalizeCoworkStore(input: unknown): CoworkStore {
  const payload = asObject(input);
  const rawSessions = arrayValue(payload?.sessions);
  return {
    version: intValue(payload?.version, 1),
    sessions: rawSessions.map(asCoworkSession).filter((session): session is CoworkSession => session !== null),
  };
}

export function normalizeCoworkSession(input: unknown): CoworkSession {
  return asCoworkSession(input) ?? emptySession();
}

export function nativeCoworkSession(session: CoworkSession): JsonObject {
  return jsonSafeObject(session);
}

export function normalizeArchitectureName(value: unknown): string {
  const name = stringValue(value).trim().toLowerCase().replace(/-/g, "_");
  if (!name || name === "hybrid") {
    return ADAPTIVE_STARTER;
  }
  return CANONICAL_ARCHITECTURES.has(name) ? name : ADAPTIVE_STARTER;
}

function asCoworkSession(input: unknown): CoworkSession | null {
  const raw = asObject(input);
  const id = stringValue(raw?.id).trim();
  if (!raw || !id) {
    return null;
  }
  const workflowMode = normalizeArchitectureName(raw.workflow_mode ?? raw.architecture ?? raw.mode);
  const now = stringValue(raw.created_at ?? raw.updated_at);
  const branches = normalizeBranches(raw.branches, workflowMode, now);
  const currentBranchId = normalizeCurrentBranchId(raw.current_branch_id, branches);
  return {
    ...jsonSafeObject(raw),
    id,
    title: stringValue(raw.title).trim() || id,
    goal: stringValue(raw.goal).trim(),
    status: stringValue(raw.status).trim() || "active",
    workflow_mode: workflowMode,
    current_branch_id: currentBranchId,
    current_focus_task: stringValue(raw.current_focus_task),
    workspace_dir: stringValue(raw.workspace_dir),
    agents: normalizeMap(raw.agents, normalizeAgent),
    tasks: normalizeMap(raw.tasks, normalizeTask),
    threads: normalizeJsonMap(raw.threads),
    messages: normalizeJsonMap(raw.messages),
    mailbox: normalizeJsonMap(raw.mailbox),
    events: normalizeEvents(raw.events),
    trace_spans: normalizeObjectArray(raw.trace_spans),
    agent_steps: normalizeObjectArray(raw.agent_steps),
    observation_details: normalizeJsonMap(raw.observation_details),
    sensitive_artifacts: normalizeJsonMap(raw.sensitive_artifacts),
    delegation_guardrails: normalizeJsonMap(raw.delegation_guardrails),
    delegated_briefs: normalizeJsonMap(raw.delegated_briefs),
    delegated_tasks: normalizeJsonMap(raw.delegated_tasks),
    isolated_sub_agent_contexts: normalizeJsonMap(raw.isolated_sub_agent_contexts),
    sub_agent_results: normalizeJsonMap(raw.sub_agent_results),
    run_metrics: normalizeObjectArray(raw.run_metrics),
    scheduler_decisions: normalizeObjectArray(raw.scheduler_decisions),
    branches,
    stage_records: normalizeObjectArray(raw.stage_records),
    artifacts: stringList(raw.artifacts),
    shared_memory: normalizeSharedMemory(raw.shared_memory),
    shared_summary: stringValue(raw.shared_summary),
    final_draft: stringValue(raw.final_draft),
    completion_decision: asObject(raw.completion_decision) ?? {},
    session_final_result: asObject(raw.session_final_result) ?? null,
    swarm_plan: asObject(raw.swarm_plan) ?? {},
    budget_limits: { ...DEFAULT_BUDGET_LIMITS, ...(asObject(raw.budget_limits ?? raw.budgets) ?? {}) },
    budget_usage: normalizeBudgetUsage(raw.budget_usage),
    stop_reason: stringValue(raw.stop_reason),
    blueprint: asObject(raw.blueprint) ?? {},
    blueprint_diagnostics: normalizeObjectArray(raw.blueprint_diagnostics),
    runtime_state: asObject(raw.runtime_state) ?? {},
    created_at: stringValue(raw.created_at) || now,
    updated_at: stringValue(raw.updated_at) || now,
    rounds: intValue(raw.rounds, 0),
    no_progress_rounds: intValue(raw.no_progress_rounds, 0),
  };
}

function emptySession(): CoworkSession {
  return {
    id: "",
    title: "",
    goal: "",
    status: "active",
    workflow_mode: ADAPTIVE_STARTER,
    current_branch_id: DEFAULT_BRANCH_ID,
    current_focus_task: "",
    workspace_dir: "",
    agents: {},
    tasks: {},
    threads: {},
    messages: {},
    mailbox: {},
    events: [],
    trace_spans: [],
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
    branches: { [DEFAULT_BRANCH_ID]: defaultBranch(ADAPTIVE_STARTER, "") },
    stage_records: [],
    artifacts: [],
    shared_memory: normalizeSharedMemory(null),
    shared_summary: "",
    final_draft: "",
    completion_decision: {},
    session_final_result: null,
    swarm_plan: {},
    budget_limits: { ...DEFAULT_BUDGET_LIMITS },
    budget_usage: { ...DEFAULT_BUDGET_USAGE },
    stop_reason: "",
    blueprint: {},
    blueprint_diagnostics: [],
    runtime_state: {},
    created_at: "",
    updated_at: "",
    rounds: 0,
    no_progress_rounds: 0,
  };
}

function normalizeAgent(input: unknown): CoworkAgent | null {
  const raw = asObject(input);
  const id = stringValue(raw?.id).trim();
  if (!raw || !id) {
    return null;
  }
  return {
    ...jsonSafeObject(raw),
    id,
    name: stringValue(raw.name).trim() || id,
    role: stringValue(raw.role),
    goal: stringValue(raw.goal),
    responsibilities: stringList(raw.responsibilities),
    tools: stringList(raw.tools),
    subscriptions: stringList(raw.subscriptions),
    communication_policy: stringValue(raw.communication_policy),
    context_policy: stringValue(raw.context_policy),
    status: stringValue(raw.status).trim() || "idle",
    private_summary: stringValue(raw.private_summary),
    inbox: stringList(raw.inbox),
    current_task_id: nullableString(raw.current_task_id),
    current_task_title: nullableString(raw.current_task_title),
    last_active_at: nullableString(raw.last_active_at),
    rounds: intValue(raw.rounds, 0),
    parent_agent_id: nullableString(raw.parent_agent_id),
    team_id: stringValue(raw.team_id),
    lifetime: stringValue(raw.lifetime) || "persistent",
    lifecycle_status: stringValue(raw.lifecycle_status) || "active",
    source_blueprint_id: stringValue(raw.source_blueprint_id),
    source_event_id: stringValue(raw.source_event_id),
    spawn_reason: stringValue(raw.spawn_reason),
    delegated_task_id: stringValue(raw.delegated_task_id),
    delegated_brief_id: stringValue(raw.delegated_brief_id),
    isolated_context_id: stringValue(raw.isolated_context_id),
    sub_agent_scope: stringValue(raw.sub_agent_scope),
  };
}

function normalizeTask(input: unknown): CoworkTask | null {
  const raw = asObject(input);
  const id = stringValue(raw?.id).trim();
  if (!raw || !id) {
    return null;
  }
  const now = stringValue(raw.created_at ?? raw.updated_at);
  return {
    ...jsonSafeObject(raw),
    id,
    title: stringValue(raw.title).trim() || id,
    description: stringValue(raw.description),
    assigned_agent_id: nullableString(raw.assigned_agent_id),
    dependencies: stringList(raw.dependencies),
    status: stringValue(raw.status).trim() || "pending",
    result: nullableString(raw.result),
    result_data: asObject(raw.result_data) ?? {},
    confidence: numberValue(raw.confidence),
    error: nullableString(raw.error),
    priority: intValue(raw.priority, 0),
    expected_output: stringValue(raw.expected_output),
    review_required: Boolean(raw.review_required),
    reviewer_agent_ids: stringList(raw.reviewer_agent_ids),
    review_status: stringValue(raw.review_status),
    fanout_group_id: stringValue(raw.fanout_group_id),
    merge_task_id: stringValue(raw.merge_task_id),
    source_blueprint_id: stringValue(raw.source_blueprint_id),
    source_event_id: stringValue(raw.source_event_id),
    runtime_created: Boolean(raw.runtime_created),
    created_at: stringValue(raw.created_at) || now,
    updated_at: stringValue(raw.updated_at) || now,
  };
}

function normalizeBranches(input: unknown, workflowMode: string, timestamp: string): Record<string, CoworkBranch> {
  const branches = normalizeMap(input, (item) => normalizeBranch(item, workflowMode, timestamp));
  if (Object.keys(branches).length > 0) {
    return branches;
  }
  return { [DEFAULT_BRANCH_ID]: defaultBranch(workflowMode, timestamp) };
}

function normalizeBranch(input: unknown, workflowMode: string, timestamp: string): CoworkBranch | null {
  const raw = asObject(input);
  const id = stringValue(raw?.id).trim();
  if (!raw || !id) {
    return null;
  }
  return {
    ...jsonSafeObject(raw),
    id,
    title: stringValue(raw.title).trim() || (id === DEFAULT_BRANCH_ID ? "Default" : id),
    architecture: normalizeArchitectureName(raw.architecture ?? workflowMode),
    status: stringValue(raw.status).trim() || "active",
    topology_reference: asObject(raw.topology_reference) ?? {},
    source_branch_id: nullableString(raw.source_branch_id),
    source_stage_record_id: nullableString(raw.source_stage_record_id),
    derivation_event_id: nullableString(raw.derivation_event_id),
    derivation_reason: stringValue(raw.derivation_reason),
    inherited_context_summary: stringValue(raw.inherited_context_summary),
    runtime_state: asObject(raw.runtime_state) ?? {},
    completion_decision: asObject(raw.completion_decision) ?? {},
    branch_result: asObject(raw.branch_result) ?? null,
    created_at: stringValue(raw.created_at) || timestamp,
    updated_at: stringValue(raw.updated_at) || timestamp,
  };
}

function defaultBranch(workflowMode: string, timestamp: string): CoworkBranch {
  return {
    id: DEFAULT_BRANCH_ID,
    title: "Default",
    architecture: normalizeArchitectureName(workflowMode),
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
  };
}

function normalizeCurrentBranchId(input: unknown, branches: Record<string, CoworkBranch>): string {
  const preferred = stringValue(input).trim();
  if (preferred && branches[preferred]) {
    return preferred;
  }
  return branches[DEFAULT_BRANCH_ID] ? DEFAULT_BRANCH_ID : Object.keys(branches)[0] ?? DEFAULT_BRANCH_ID;
}

function normalizeEvents(input: unknown): CoworkEvent[] {
  return normalizeObjectArray(input).map((event) => ({
    ...event,
    id: stringValue(event.id),
    type: stringValue(event.type),
    message: stringValue(event.message),
    ...(event.actor_id !== undefined ? { actor_id: nullableString(event.actor_id) } : {}),
    ...(isJsonObject(event.data) ? { data: event.data } : {}),
    ...(event.created_at !== undefined ? { created_at: stringValue(event.created_at) } : {}),
  })).filter((event) => event.id && event.type);
}

function normalizeSharedMemory(input: unknown): Record<string, JsonObject[]> {
  const raw = asObject(input);
  const memory: Record<string, JsonObject[]> = {};
  for (const bucket of SHARED_MEMORY_BUCKETS) {
    memory[bucket] = arrayValue(raw?.[bucket]).map((item) => {
      if (isJsonObject(item)) {
        return jsonSafeObject(item);
      }
      return { text: stringValue(item).trim() };
    }).filter((item) => Object.keys(item).length > 0 && stringValue(item.text ?? "x").trim() !== "");
  }
  return memory;
}

function normalizeBudgetUsage(input: unknown): JsonObject {
  const raw = asObject(input) ?? {};
  const usage: JsonObject = { ...DEFAULT_BUDGET_USAGE };
  for (const [key, value] of Object.entries(raw)) {
    usage[key] = key === "stop_reason" ? stringValue(value) : numberValue(value) ?? value;
  }
  return usage;
}

function normalizeMap<T>(input: unknown, normalize: (item: unknown) => T | null): Record<string, T> {
  const raw = asObject(input);
  if (!raw) {
    return {};
  }
  const entries: Array<[string, T]> = [];
  for (const item of Object.values(raw)) {
    const normalized = normalize(item);
    const candidate = normalized as unknown;
    if (isJsonObject(candidate) && typeof candidate.id === "string") {
      entries.push([candidate.id, normalized as T]);
    }
  }
  return Object.fromEntries(entries);
}

function normalizeJsonMap(input: unknown): Record<string, JsonObject> {
  return normalizeMap(input, (item) => isJsonObject(item) && typeof item.id === "string" ? jsonSafeObject(item) : null);
}

function normalizeObjectArray(input: unknown): JsonObject[] {
  return arrayValue(input).filter(isJsonObject).map(jsonSafeObject);
}

function arrayValue(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asObject(input: unknown): JsonObject | undefined {
  return isJsonObject(input) ? input : undefined;
}

function jsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (isJsonObject(value)) {
    return jsonSafeObject(value);
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  return stringValue(value);
}

function jsonSafeObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
}

function stringList(input: unknown): string[] {
  if (typeof input === "string") {
    return input.trim() ? [input.trim()] : [];
  }
  return arrayValue(input).map(stringValue).map((item) => item.trim()).filter(Boolean);
}

function nullableString(input: unknown): string | null {
  if (input === null || input === undefined || input === "") {
    return null;
  }
  return stringValue(input);
}

function stringValue(input: unknown): string {
  return input === null || input === undefined ? "" : String(input);
}

function intValue(input: unknown, fallback: number): number {
  const parsed = Number.parseInt(stringValue(input), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberValue(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
