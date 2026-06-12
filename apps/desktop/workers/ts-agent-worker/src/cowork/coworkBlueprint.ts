import { createHash } from "node:crypto";

import { isJsonObject, type JsonObject } from "../protocol/messages.ts";

type BlueprintDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
  value?: unknown;
};

type BlueprintAgent = {
  id: string;
  name: string;
  role: string;
  goal: string;
  responsibilities: string[];
  tools: string[];
  subscriptions: string[];
  communication_policy: string;
  context_policy: string;
  parent_agent_id: string | null;
  team_id: string;
  layout: JsonObject;
};

type BlueprintTask = {
  id: string;
  title: string;
  description: string;
  assigned_agent_id: string | null;
  dependencies: string[];
  priority: number;
  expected_output: string;
  review_required: boolean;
  reviewer_agent_ids: string[];
  fanout_group_id: string;
  merge_task_id: string;
  layout: JsonObject;
};

type BlueprintRoute = {
  id: string;
  source_id: string;
  target_id: string;
  kind: string;
  topic: string;
  event_type: string;
  request_type: string;
  required: boolean;
};

type CoworkBlueprint = JsonObject & {
  schema_version: "cowork.blueprint.v1";
  id: string;
  goal: string;
  title: string;
  workflow_mode: string;
  lead_agent_id: string;
  agents: BlueprintAgent[];
  tasks: BlueprintTask[];
  routes: BlueprintRoute[];
  review: {
    required_reviewers: string[];
    gates: JsonObject[];
    merge_required: boolean;
    synthesis_task_id: string;
  };
  budgets: JsonObject;
  layout: JsonObject;
  metadata: JsonObject;
};

export type BlueprintValidationResult = {
  ok: boolean;
  blueprint: CoworkBlueprint;
  diagnostics: BlueprintDiagnostic[];
};

export type BlueprintPreviewResult = BlueprintValidationResult & {
  graph_preview: JsonObject;
  budget_plan: JsonObject;
  initial_ready_work: JsonObject;
};

const ADAPTIVE_STARTER = "adaptive_starter";
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
const ACCEPTED_ARCHITECTURES = new Set([...CANONICAL_ARCHITECTURES, "hybrid"]);
const DEFAULT_ALLOWED_TOOLS = new Set([
  "cowork_internal",
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
  "delete_file",
  "exec",
]);
const DEFAULT_BUDGET_LIMITS: Record<string, number | null> = {
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
const BUDGET_HARD_CAPS: Record<string, number> = {
  max_rounds_per_run: 200,
  parallel_width: 50,
  max_agent_calls_per_run: 500,
  max_agent_calls_total: 5000,
  max_spawned_agents: 200,
  max_work_units: 1000,
  max_retry_attempts: 20,
  max_tool_calls: 10000,
  max_tokens: 20_000_000,
  max_cost: 10_000,
  max_wall_time_seconds: 7 * 24 * 60 * 60,
};
const BUDGET_ALIASES: Record<string, string> = {
  max_rounds: "max_rounds_per_run",
  rounds: "max_rounds_per_run",
  max_agent_calls: "max_agent_calls_per_run",
  agent_calls: "max_agent_calls_per_run",
  max_agents: "parallel_width",
  parallelism: "parallel_width",
  work_units: "max_work_units",
  retry_attempts: "max_retry_attempts",
};

export function previewBlueprint(
  raw: unknown,
  policy?: JsonObject | null,
  defaultGoal = "",
): BlueprintPreviewResult {
  const validation = validateBlueprint(raw, policy, defaultGoal);
  const blueprint = validation.blueprint;
  const usage = defaultBudgetUsage();
  return {
    ...validation,
    graph_preview: buildBlueprintGraph(blueprint),
    budget_plan: {
      limits: blueprint.budgets,
      usage,
      remaining: budgetRemaining(blueprint.budgets, usage),
    },
    initial_ready_work: initialReadyWork(blueprint),
  };
}

export function validateBlueprint(
  raw: unknown,
  policy?: JsonObject | null,
  defaultGoal = "",
): BlueprintValidationResult {
  const blueprint = normalizeBlueprint(raw, defaultGoal);
  const diagnostics: BlueprintDiagnostic[] = [];
  const rawData = isJsonObject(raw) ? raw : {};

  diagnoseDuplicateIds(rawData.agents, "agents", diagnostics);
  diagnoseDuplicateIds(rawData.tasks, "tasks", diagnostics);
  const architectureValue = rawData.architecture ?? rawData.workflow_mode ?? rawData.mode;
  const architectureDiagnostic = architectureFallbackDiagnostic(
    architectureValue,
    "architecture" in rawData ? "architecture" : "workflow_mode",
  );
  if (architectureDiagnostic) {
    diagnostics.push(architectureDiagnostic);
  }

  const agentIds = new Set(blueprint.agents.map((agent) => agent.id));
  const taskIds = new Set(blueprint.tasks.map((task) => task.id));
  if (!blueprint.goal) {
    diagnostics.push(diagnostic("error", "missing_goal", "Blueprint goal is required.", "goal"));
  }
  if (blueprint.agents.length === 0) {
    diagnostics.push(diagnostic("error", "missing_agents", "At least one agent is required.", "agents"));
  }
  blueprint.agents.forEach((agent, index) => {
    if (agent.parent_agent_id && !agentIds.has(agent.parent_agent_id)) {
      diagnostics.push(diagnostic("error", "missing_parent_agent", `Parent agent '${agent.parent_agent_id}' does not exist.`, `agents[${index}].parent_agent_id`));
    }
    for (const tool of agent.tools) {
      if (!toolAllowed(tool, policy)) {
        diagnostics.push(diagnostic("error", "tool_disallowed", `Tool '${tool}' is not allowed by Cowork blueprint policy.`, `agents[${index}].tools`, tool));
      }
    }
  });

  blueprint.tasks.forEach((task, index) => {
    if (task.assigned_agent_id && !agentIds.has(task.assigned_agent_id)) {
      diagnostics.push(diagnostic("error", "missing_task_owner", `Task owner '${task.assigned_agent_id}' does not exist.`, `tasks[${index}].assigned_agent_id`));
    }
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        diagnostics.push(diagnostic("error", "missing_task_dependency", `Task dependency '${dependency}' does not exist.`, `tasks[${index}].dependencies`));
      }
    }
    for (const reviewer of task.reviewer_agent_ids) {
      if (!agentIds.has(reviewer)) {
        diagnostics.push(diagnostic("error", "missing_task_reviewer", `Reviewer '${reviewer}' does not exist.`, `tasks[${index}].reviewer_agent_ids`));
      }
    }
    if (task.merge_task_id && !taskIds.has(task.merge_task_id)) {
      diagnostics.push(diagnostic("error", "missing_merge_task", `Merge task '${task.merge_task_id}' does not exist.`, `tasks[${index}].merge_task_id`));
    }
  });

  blueprint.routes.forEach((route, index) => {
    if (route.source_id && !agentIds.has(route.source_id) && !["user", "session", "team"].includes(route.source_id)) {
      diagnostics.push(diagnostic("error", "missing_route_source", `Route source '${route.source_id}' does not exist.`, `routes[${index}].source_id`));
    }
    if (route.target_id && !agentIds.has(route.target_id) && !["user", "session", "team"].includes(route.target_id)) {
      diagnostics.push(diagnostic("error", "missing_route_target", `Route target '${route.target_id}' does not exist.`, `routes[${index}].target_id`));
    }
  });

  blueprint.review.required_reviewers.forEach((reviewer, index) => {
    if (!agentIds.has(reviewer)) {
      diagnostics.push(diagnostic("error", "missing_review_agent", `Reviewer '${reviewer}' does not exist.`, `review.required_reviewers[${index}]`));
    }
  });

  const cycle = taskDependencyCycle(blueprint.tasks);
  if (cycle.length > 0) {
    diagnostics.push(diagnostic("error", "task_dependency_cycle", `Task dependencies contain a cycle: ${cycle.join(" -> ")}`, "tasks"));
  }
  diagnostics.push(...budgetDiagnostics(rawData.budgets ?? rawData.budget, blueprint.budgets));

  return {
    ok: !diagnostics.some((item) => item.severity === "error"),
    blueprint,
    diagnostics,
  };
}

export function normalizeBlueprint(raw: unknown, defaultGoal = ""): CoworkBlueprint {
  const data = isJsonObject(raw) ? raw : {};
  const goal = stringValue(data.goal ?? defaultGoal).trim();
  const workflowMode = normalizeArchitectureName(data.architecture ?? data.workflow_mode ?? data.mode);
  const title = (stringValue(data.title) || titleFromGoal(goal) || "Cowork Session").trim();
  const layout = isJsonObject(data.layout) ? data.layout : {};
  const agents = normalizeAgents(data.agents, goal, layout);
  const agentIds = new Set(agents.map((agent) => agent.id));
  let leadAgentId = slug(data.lead_agent_id ?? data.lead ?? "");
  if (!agentIds.has(leadAgentId)) {
    leadAgentId = defaultLeadId(agents);
  }
  const tasks = normalizeTasks(data.tasks, goal, agents, layout);
  const routes = normalizeRoutes(data.routes, agents);
  const blueprint = {
    schema_version: "cowork.blueprint.v1" as const,
    goal,
    title,
    workflow_mode: workflowMode,
    lead_agent_id: leadAgentId,
    agents,
    tasks,
    routes,
    review: normalizeReview(data.review, tasks),
    budgets: normalizeBudgetLimits(data.budgets ?? data.budget),
    layout: jsonSafeObject(layout),
    metadata: isJsonObject(data.metadata) ? jsonSafeObject(data.metadata) : {},
  } satisfies Omit<CoworkBlueprint, "id">;
  return {
    ...blueprint,
    id: blueprintFingerprint(blueprint),
  };
}

function normalizeAgents(value: unknown, goal: string, layout: JsonObject): BlueprintAgent[] {
  const rawAgents = Array.isArray(value) && value.length > 0 ? value : defaultAgents(goal);
  const used = new Set<string>();
  const layoutNodes = isJsonObject(layout.nodes) ? layout.nodes : {};
  return rawAgents.map((item, index) => {
    const raw = isJsonObject(item) ? item : {};
    const id = dedupeId(slug(raw.id ?? raw.name ?? raw.role ?? `agent_${index + 1}`, "agent"), used);
    return {
      id,
      name: (stringValue(raw.name) || id).trim(),
      role: (stringValue(raw.role) || "Collaborator").trim(),
      goal: (stringValue(raw.goal) || goal || "Contribute to the shared goal.").trim(),
      responsibilities: stringList(raw.responsibilities),
      tools: stringList(raw.tools).length > 0 ? stringList(raw.tools) : ["cowork_internal"],
      subscriptions: stringList(raw.subscriptions).length > 0 ? stringList(raw.subscriptions) : defaultSubscriptions(raw, id),
      communication_policy: stringValue(raw.communication_policy).trim(),
      context_policy: stringValue(raw.context_policy).trim(),
      parent_agent_id: raw.parent_agent_id ? slug(raw.parent_agent_id) : null,
      team_id: stringValue(raw.team_id).trim(),
      layout: isJsonObject(layoutNodes[id]) ? jsonSafeObject(layoutNodes[id] as JsonObject) : {},
    };
  });
}

function normalizeTasks(value: unknown, goal: string, agents: BlueprintAgent[], layout: JsonObject): BlueprintTask[] {
  const leadId = defaultLeadId(agents);
  const rawTasks = Array.isArray(value) && value.length > 0
    ? value
    : [{
      id: "lead_start",
      title: "Decide team plan and delegation",
      description: `Analyze the goal and decide the first concrete work split: ${goal}`,
      assigned_agent_id: leadId,
    }];
  const agentIds = new Set(agents.map((agent) => agent.id));
  const used = new Set<string>();
  const layoutNodes = isJsonObject(layout.nodes) ? layout.nodes : {};
  return rawTasks.map((item, index) => {
    const raw = isJsonObject(item) ? item : {};
    const id = dedupeId(slug(raw.id ?? raw.title ?? `task_${index + 1}`, "task"), used);
    const owner = slug(raw.assigned_agent_id ?? raw.owner ?? "");
    const review = isJsonObject(raw.review) ? raw.review : {};
    return {
      id,
      title: (stringValue(raw.title) || id).trim(),
      description: (stringValue(raw.description) || stringValue(raw.title) || goal || id).trim(),
      assigned_agent_id: owner && agentIds.has(owner) ? owner : owner || null,
      dependencies: stringList(raw.dependencies ?? raw.depends_on).map((itemId) => slug(itemId)),
      priority: intValue(raw.priority, 0),
      expected_output: (stringValue(raw.expected_output) || stringValue(raw.expected_outputs)).trim(),
      review_required: Boolean(raw.review_required ?? review.required),
      reviewer_agent_ids: stringList(raw.reviewer_agent_ids ?? review.reviewer_agent_ids ?? review.reviewers).map((itemId) => slug(itemId)),
      fanout_group_id: stringValue(raw.fanout_group_id).trim(),
      merge_task_id: raw.merge_task_id ? slug(raw.merge_task_id) : "",
      layout: isJsonObject(layoutNodes[id]) ? jsonSafeObject(layoutNodes[id] as JsonObject) : {},
    };
  });
}

function normalizeRoutes(value: unknown, agents: BlueprintAgent[]): BlueprintRoute[] {
  const leadId = defaultLeadId(agents);
  const rawRoutes = Array.isArray(value) && value.length > 0
    ? value
    : leadId ? [{ id: "user_to_lead", from: "user", to: leadId, kind: "direct", topic: "goal" }] : [];
  const used = new Set<string>();
  return rawRoutes.map((item, index) => {
    const raw = isJsonObject(item) ? item : {};
    return {
      id: dedupeId(slug(raw.id ?? `route_${index + 1}`, "route"), used),
      source_id: slug(raw.source_id ?? raw.from ?? raw.source ?? "user", "user"),
      target_id: slug(raw.target_id ?? raw.to ?? raw.target ?? "team", "team"),
      kind: (stringValue(raw.kind) || stringValue(raw.type) || "direct").trim().toLowerCase(),
      topic: stringValue(raw.topic).trim(),
      event_type: stringValue(raw.event_type).trim(),
      request_type: stringValue(raw.request_type).trim(),
      required: Boolean(raw.required),
    };
  });
}

function normalizeReview(value: unknown, tasks: BlueprintTask[]): CoworkBlueprint["review"] {
  const raw = isJsonObject(value) ? value : {};
  const merge = isJsonObject(raw.merge) ? raw.merge : {};
  let synthesisTaskId = slug(raw.synthesis_task_id ?? merge.task_id ?? "");
  if (!synthesisTaskId) {
    synthesisTaskId = tasks.find((task) => task.merge_task_id || task.id.includes("synth"))?.id ?? "";
  }
  const rawGates = Array.isArray(raw.gates) ? raw.gates : [];
  return {
    required_reviewers: stringList(raw.required_reviewers ?? raw.reviewers).map((item) => slug(item)),
    gates: rawGates.filter(isJsonObject).map(jsonSafeObject),
    merge_required: Boolean(raw.merge_required ?? merge.required),
    synthesis_task_id: synthesisTaskId,
  };
}

function buildBlueprintGraph(blueprint: CoworkBlueprint): JsonObject {
  const nodes: JsonObject[] = [{
    id: "session",
    kind: "session",
    title: blueprint.title || "Cowork Session",
    label: blueprint.title || "Cowork Session",
    detail: blueprint.goal,
    status: "preview",
    badge: blueprint.workflow_mode,
    source_blueprint_id: blueprint.id,
  }];
  const edges: JsonObject[] = [];
  const layoutNodes = isJsonObject(blueprint.layout.nodes) ? blueprint.layout.nodes : {};

  blueprint.agents.forEach((agent, index) => {
    const position = isJsonObject(layoutNodes[agent.id]) ? layoutNodes[agent.id] : {};
    nodes.push({
      id: `agent:${agent.id}`,
      entity_id: agent.id,
      kind: "agent",
      title: agent.name || agent.id,
      label: agent.name || agent.id,
      detail: agent.role,
      status: "planned",
      badge: agent.id === blueprint.lead_agent_id ? "lead" : agent.team_id,
      x: numberValue(position.x) ?? 280 + (index % 5) * 170,
      y: numberValue(position.y) ?? 160 + Math.floor(index / 5) * 110,
      source_blueprint_id: agent.id,
    });
    addEdge(edges, "session", `agent:${agent.id}`, "member", { source_blueprint_id: agent.id });
    if (agent.parent_agent_id) {
      addEdge(edges, `agent:${agent.parent_agent_id}`, `agent:${agent.id}`, "parent_of");
    }
  });

  blueprint.tasks.forEach((task, index) => {
    const position = isJsonObject(layoutNodes[task.id]) ? layoutNodes[task.id] : {};
    nodes.push({
      id: `task:${task.id}`,
      entity_id: task.id,
      kind: "task",
      title: task.title || task.id,
      label: task.title || task.id,
      detail: task.description,
      status: "planned",
      badge: task.review_required ? "review" : "",
      x: numberValue(position.x) ?? 240 + (index % 4) * 220,
      y: numberValue(position.y) ?? 390 + Math.floor(index / 4) * 100,
      source_blueprint_id: task.id,
    });
    addEdge(edges, "session", `task:${task.id}`, "has_task");
    if (task.assigned_agent_id) {
      addEdge(edges, `task:${task.id}`, `agent:${task.assigned_agent_id}`, "assigned_to");
    }
    task.dependencies.forEach((dependency) => addEdge(edges, `task:${dependency}`, `task:${task.id}`, "depends_on"));
    if (task.merge_task_id) {
      addEdge(edges, `task:${task.id}`, `task:${task.merge_task_id}`, "synthesizes");
    }
  });

  blueprint.routes.forEach((route) => {
    addEdge(edges, routeNodeId(route.source_id), routeNodeId(route.target_id), route.kind || "route", {
      topic: route.topic,
      event_type: route.event_type,
      request_type: route.request_type,
      source_blueprint_id: route.id,
    });
  });

  return {
    schema_version: "cowork.graph.preview.v1",
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      node_kinds: countBy(nodes, "kind"),
      edge_kinds: countBy(edges, "kind"),
    },
    truncated: { nodes: false, edges: false, hidden_nodes: 0, hidden_edges: 0 },
  };
}

function initialReadyWork(blueprint: CoworkBlueprint): JsonObject {
  const ready = blueprint.tasks.filter((task) => task.dependencies.length === 0);
  const byAgent: Record<string, string[]> = {};
  for (const task of ready) {
    const key = task.assigned_agent_id || "unassigned";
    byAgent[key] ??= [];
    byAgent[key].push(task.id);
  }
  return {
    ready_task_ids: ready.map((task) => task.id),
    ready_by_agent: Object.fromEntries(Object.entries(byAgent).sort(([left], [right]) => left.localeCompare(right))),
    lead_agent_id: blueprint.lead_agent_id,
  };
}

function normalizeArchitectureName(value: unknown): string {
  const name = (stringValue(value) || ADAPTIVE_STARTER).trim().toLowerCase().replace(/-/g, "_");
  if (name === "hybrid") {
    return ADAPTIVE_STARTER;
  }
  return CANONICAL_ARCHITECTURES.has(name) ? name : ADAPTIVE_STARTER;
}

function architectureFallbackDiagnostic(value: unknown, path: string): BlueprintDiagnostic | null {
  const raw = stringValue(value).trim();
  if (!raw) {
    return null;
  }
  const name = raw.toLowerCase().replace(/-/g, "_");
  if (ACCEPTED_ARCHITECTURES.has(name)) {
    return null;
  }
  return diagnostic("warning", "unknown_architecture_fallback", `Unknown Cowork architecture '${raw}' was normalized to '${ADAPTIVE_STARTER}'.`, path, raw);
}

function normalizeBudgetLimits(value: unknown): JsonObject {
  const raw = isJsonObject(value) ? value : {};
  const normalized: JsonObject = { ...DEFAULT_BUDGET_LIMITS };
  for (const [key, rawValue] of Object.entries(raw)) {
    const target = BUDGET_ALIASES[key] ?? key;
    normalized[target] = target in normalized ? coerceBudgetValue(target, rawValue) : jsonSafe(rawValue);
  }
  for (const key of Object.keys(DEFAULT_BUDGET_LIMITS)) {
    normalized[key] = coerceBudgetValue(key, normalized[key]);
  }
  return normalized;
}

function defaultBudgetUsage(): JsonObject {
  return {
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
}

function budgetRemaining(limits: JsonObject, usage: JsonObject): JsonObject {
  const mapping: Record<string, string> = {
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
  for (const [limitKey, usageKey] of Object.entries(mapping)) {
    const limit = limits[limitKey];
    const limitValue = numberValue(limit) ?? 0;
    const usageValue = numberValue(usage[usageKey]) ?? 0;
    remaining[limitKey] = limit === null ? null : Math.max(0, limitValue - usageValue);
  }
  remaining.parallel_width = limits.parallel_width;
  return remaining;
}

function budgetDiagnostics(raw: unknown, normalized: JsonObject): BlueprintDiagnostic[] {
  const rawDict = isJsonObject(raw) ? raw : {};
  const diagnostics: BlueprintDiagnostic[] = [];
  for (const [key, rawValue] of Object.entries(rawDict)) {
    const target = BUDGET_ALIASES[key] ?? key;
    if (target in BUDGET_HARD_CAPS && normalized[target] !== coerceNumber(rawValue)) {
      diagnostics.push(diagnostic("warning", "budget_clamped", `Budget '${key}' was clamped to policy bounds.`, `budgets.${key}`, normalized[target]));
    }
  }
  return diagnostics;
}

function coerceBudgetValue(key: string, value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_BUDGET_LIMITS[key] ?? null;
  }
  const parsed = coerceNumber(value);
  if (parsed === null) {
    return DEFAULT_BUDGET_LIMITS[key] ?? null;
  }
  const minimum = key === "parallel_width" ? 1 : 0;
  const maximum = BUDGET_HARD_CAPS[key];
  const bounded = Math.max(minimum, maximum === undefined ? parsed : Math.min(parsed, maximum));
  return key === "max_cost" ? bounded : Math.trunc(bounded);
}

function defaultAgents(goal: string): JsonObject[] {
  return [
    {
      id: "coordinator",
      name: "Coordinator",
      role: "Team coordinator",
      goal: `Keep the collaboration focused on: ${goal}`,
      responsibilities: ["Break down work", "Route questions", "Synthesize final progress"],
      tools: ["cowork_internal"],
      subscriptions: ["coordination", "handoff", "unblock", "decision", "summary"],
    },
    {
      id: "researcher",
      name: "Researcher",
      role: "Information gatherer",
      goal: `Gather useful facts and constraints for: ${goal}`,
      responsibilities: ["Investigate relevant sources", "Summarize findings", "Flag uncertainty"],
      tools: ["read_file", "list_dir", "cowork_internal"],
      subscriptions: ["research", "produce", "finding", "source", "context"],
    },
    {
      id: "analyst",
      name: "Analyst",
      role: "Reasoning and verification partner",
      goal: `Check assumptions and turn findings into decisions for: ${goal}`,
      responsibilities: ["Compare options", "Verify claims", "Identify risks"],
      tools: ["read_file", "list_dir", "cowork_internal"],
      subscriptions: ["analysis", "review", "verify", "risk", "decision"],
    },
  ];
}

function diagnoseDuplicateIds(value: unknown, field: string, diagnostics: BlueprintDiagnostic[]): void {
  const counts = new Map<string, number>();
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    const id = isJsonObject(item) ? slug(item.id ?? "") : "";
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      diagnostics.push(diagnostic("error", "duplicate_id", `Duplicate ${field.slice(0, -1)} id '${id}'.`, field, id));
    }
  }
}

function taskDependencyCycle(tasks: BlueprintTask[]): string[] {
  const graph = new Map(tasks.map((task) => [task.id, task.dependencies.filter(Boolean)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): string[] => {
    if (visiting.has(node)) {
      const index = path.indexOf(node);
      return index >= 0 ? [...path.slice(index), node] : [node, node];
    }
    if (visited.has(node)) {
      return [];
    }
    visiting.add(node);
    path.push(node);
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle.length > 0) {
        return cycle;
      }
    }
    visiting.delete(node);
    visited.add(node);
    path.pop();
    return [];
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle.length > 0) {
      return cycle;
    }
  }
  return [];
}

function toolAllowed(tool: string, policy?: JsonObject | null): boolean {
  const allowed = Array.isArray(policy?.allowed_tools)
    ? new Set(policy.allowed_tools.map((item) => stringValue(item).trim()))
    : DEFAULT_ALLOWED_TOOLS;
  return allowed.has(tool);
}

function addEdge(edges: JsonObject[], source: string, target: string, kind: string, extra: JsonObject = {}): void {
  if (!source || !target || source === target) {
    return;
  }
  if (edges.some((edge) => edge.from === source && edge.to === target && edge.kind === kind)) {
    return;
  }
  const payload: JsonObject = { from: source, to: target, source, target, kind };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== undefined && value !== "") {
      payload[key] = value;
    }
  }
  edges.push(payload);
}

function routeNodeId(value: string): string {
  if (!value || value === "session" || value === "team") {
    return "session";
  }
  if (value === "user") {
    return "user";
  }
  return `agent:${value}`;
}

function defaultLeadId(agents: BlueprintAgent[]): string {
  const ids = new Set(agents.map((agent) => agent.id));
  for (const candidate of ["coordinator", "lead", "team_lead", "team-lead"]) {
    if (ids.has(candidate)) {
      return candidate;
    }
  }
  return agents[0]?.id ?? "";
}

function defaultSubscriptions(raw: JsonObject, agentId: string): string[] {
  const values = [agentId, raw.role, ...stringList(raw.responsibilities)];
  const seen: string[] = [];
  for (const value of values) {
    const text = slug(value);
    if (text && !seen.includes(text)) {
      seen.push(text);
    }
  }
  return seen.slice(0, 12);
}

function slug(value: unknown, fallback = "item"): string {
  const text = stringValue(value).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text.slice(0, 48) || fallback;
}

function dedupeId(value: string, used: Set<string>): string {
  const base = value || "item";
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function titleFromGoal(goal: string): string {
  const text = goal.split(/\s+/).filter(Boolean).join(" ");
  if (!text) {
    return "";
  }
  return `${text.slice(0, 52).trimEnd()}${text.length > 52 ? "..." : ""}`;
}

function blueprintFingerprint(blueprint: Omit<CoworkBlueprint, "id">): string {
  const material = stableStringify(blueprint);
  return `bp_${createHash("sha1").update(material, "utf8").digest("hex").slice(0, 12)}`;
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
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), jsonSafe(item)]));
}

function countBy(items: JsonObject[], key: string): JsonObject {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = stringValue(item[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(stringValue).map((item) => item.trim()).filter(Boolean);
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function intValue(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function diagnostic(
  severity: BlueprintDiagnostic["severity"],
  code: string,
  message: string,
  path?: string,
  value?: unknown,
): BlueprintDiagnostic {
  return Object.fromEntries(
    Object.entries({ severity, code, message, path, value }).filter(([, item]) => item !== undefined && item !== ""),
  ) as BlueprintDiagnostic;
}
