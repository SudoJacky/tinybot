import { createHash } from "node:crypto";

import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { defaultPolicyRegistry } from "./coworkPolicy.ts";
import type { CoworkAgent, CoworkBranch, CoworkSession, CoworkTask } from "./coworkTypes.ts";

export interface CoworkSnapshotOptions {
  verbose?: boolean;
}

export type CoworkSessionSnapshot = JsonObject & {
  id: string;
  title: string;
  goal: string;
  status: string;
  workflow_mode: string;
  architecture: string;
  current_branch_id: string;
  agents: JsonObject[];
  tasks: JsonObject[];
  threads: JsonObject[];
  messages: JsonObject[];
  mailbox: JsonObject[];
  events: JsonObject[];
  trace_spans: JsonObject[];
  agent_steps: JsonObject[];
  observation_details: JsonObject;
  sensitive_artifacts: JsonObject;
  graph?: JsonObject;
  trace?: JsonObject[];
  task_dag?: JsonObject;
  artifact_index?: JsonObject[];
};

export function coworkSessionSnapshot(session: CoworkSession, options: CoworkSnapshotOptions = {}): CoworkSessionSnapshot {
  const verbose = options.verbose ?? true;
  const currentBranchId = session.current_branch_id || "default";
  const currentBranch = session.branches[currentBranchId] ?? Object.values(session.branches)[0] ?? null;
  const architecture = currentBranch?.architecture || session.workflow_mode || "adaptive_starter";
  const budget = budgetSnapshot(session);
  const swarmQueues = session.workflow_mode === "swarm" ? buildSwarmSchedulerQueues(session) : {};
  const swarmMetrics = session.workflow_mode === "swarm" ? buildSwarmParallelMetrics(session) : {};
  const snapshot: CoworkSessionSnapshot = {
    id: session.id,
    title: session.title,
    goal: session.goal,
    status: session.status,
    workflow_mode: session.workflow_mode,
    architecture,
    current_branch_id: currentBranchId,
    current_branch: currentBranch ? branchSnapshot(currentBranch, currentBranch.id === currentBranchId) : {},
    branches: Object.values(session.branches).map((branch) => branchSnapshot(branch, branch.id === currentBranchId)),
    branch_results: Object.values(session.branches)
      .map((branch) => branch.branch_result)
      .filter(isJsonObject)
      .map(jsonSafeObject),
    session_final_result: session.session_final_result ? jsonSafeObject(session.session_final_result) : {},
    stage_records: session.stage_records.map(jsonSafeObject),
    current_focus_task: session.current_focus_task,
    workspace_dir: session.workspace_dir,
    artifacts: [...session.artifacts],
    shared_memory: jsonSafeObject(session.shared_memory),
    shared_summary: session.shared_summary,
    final_draft: session.final_draft,
    completion_decision: jsonSafeObject(session.completion_decision),
    budget,
    budget_state: budget,
    stop_reason: session.stop_reason,
    control_scopes: {
      session: ["run", "pause", "resume", "delete", "emergency_stop"],
      branch: ["list", "select", "derive"],
      agent: ["send_message"],
      task: ["add", "assign", "retry", "review"],
      work_unit: ["retry", "skip", "cancel"],
      feedback: ["send_message"],
      emergency_stop: ["stop_future_scheduling"],
    },
    blueprint: verbose ? jsonSafeObject(session.blueprint) : {},
    blueprint_metadata: blueprintMetadata(session.blueprint),
    blueprint_diagnostics: session.blueprint_diagnostics.map(jsonSafeObject),
    created_at: session.created_at,
    updated_at: session.updated_at,
    rounds: session.rounds,
    no_progress_rounds: session.no_progress_rounds,
    agents: Object.values(session.agents).map((agent) => agentSnapshot(session, agent, verbose)),
    tasks: Object.values(session.tasks).map((task) => taskSnapshot(task, verbose)),
    threads: Object.values(session.threads).map(threadSnapshot),
    messages: verbose ? Object.values(session.messages).map(messageSnapshot) : [],
    mailbox: verbose ? Object.values(session.mailbox).map(mailboxSnapshot) : [],
    events: session.events.slice(-80).map(eventSnapshot),
    trace_spans: verbose ? session.trace_spans.slice(-160).map(traceSpanSnapshot) : [],
    agent_steps: verbose ? session.agent_steps.map(jsonSafeObject) : [],
    observation_details: verbose ? jsonSafeObject(session.observation_details) : {},
    sensitive_artifacts: verbose ? redactedSensitiveArtifacts(session.sensitive_artifacts) : {},
    delegation_guardrails: Object.values(session.delegation_guardrails).map(jsonSafeObject),
    delegated_briefs: Object.values(session.delegated_briefs).map(jsonSafeObject),
    delegated_tasks: Object.values(session.delegated_tasks).map(jsonSafeObject),
    isolated_sub_agent_contexts: Object.values(session.isolated_sub_agent_contexts).map(jsonSafeObject),
    sub_agent_results: Object.values(session.sub_agent_results).map(jsonSafeObject),
    run_metrics: session.run_metrics.slice(-20).map(jsonSafeObject),
    scheduler_decisions: verbose ? session.scheduler_decisions.slice(-40).map(jsonSafeObject) : [],
    swarm_plan: jsonSafeObject(session.swarm_plan),
    orchestration_assessment: orchestrationAssessment(session.swarm_plan),
    evaluation_results: Array.isArray(session.runtime_state.swarm_evaluations)
      ? session.runtime_state.swarm_evaluations.filter(isJsonObject).map(jsonSafeObject)
      : [],
    swarm_queues: swarmQueues,
    swarm_metrics: swarmMetrics,
    swarm_organization: buildCoworkSwarmOrganization(session),
    large_swarm_summary: buildCoworkLargeSwarmSummary(session),
  };

  if (verbose) {
    const policy = defaultPolicyRegistry().resolve(architecture);
    snapshot.architecture_topology = policy.topology(session, { branchId: currentBranchId }).payload;
    snapshot.organization_projection = policy.buildProjection(session, { branchId: currentBranchId }).payload;
    snapshot.graph = buildCoworkGraph(session);
    snapshot.trace = buildCoworkTrace(session);
    snapshot.task_dag = buildCoworkTaskDag(session);
    snapshot.artifact_index = buildCoworkArtifactIndex(session);
  }
  return snapshot;
}

function agentSnapshot(session: CoworkSession, agent: CoworkAgent, verbose: boolean): JsonObject {
  const currentTaskTitle = agent.current_task_title
    || (agent.current_task_id ? session.tasks[agent.current_task_id]?.title : "")
    || null;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    goal: agent.goal,
    responsibilities: [...agent.responsibilities],
    subscriptions: [...agent.subscriptions],
    status: agent.status,
    private_summary: verbose ? agent.private_summary : "",
    inbox_count: agent.inbox.length,
    current_task_id: agent.current_task_id,
    current_task_title: currentTaskTitle,
    last_active_at: agent.last_active_at,
    rounds: agent.rounds,
    parent_agent_id: agent.parent_agent_id,
    team_id: agent.team_id,
    lifetime: agent.lifetime,
    lifecycle_status: agent.lifecycle_status,
    source_blueprint_id: agent.source_blueprint_id,
    delegated_task_id: agent.delegated_task_id,
    delegated_brief_id: agent.delegated_brief_id,
    isolated_context_id: agent.isolated_context_id,
    sub_agent_scope: agent.sub_agent_scope,
  };
}

function taskSnapshot(task: CoworkTask, verbose: boolean): JsonObject {
  return {
    id: task.id,
    title: task.title,
    description: verbose ? task.description : "",
    assigned_agent_id: task.assigned_agent_id,
    dependencies: [...task.dependencies],
    status: task.status,
    result: verbose ? task.result : "",
    result_data: verbose ? jsonSafeObject(task.result_data) : {},
    confidence: task.confidence,
    error: task.error,
    priority: task.priority,
    expected_output: task.expected_output,
    review_required: task.review_required,
    reviewer_agent_ids: [...task.reviewer_agent_ids],
    review_status: task.review_status,
    fanout_group_id: task.fanout_group_id,
    merge_task_id: task.merge_task_id,
    source_blueprint_id: task.source_blueprint_id,
    runtime_created: task.runtime_created,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function threadSnapshot(thread: JsonObject): JsonObject {
  const messageIds = arrayValue(thread.message_ids).map(stringValue).filter(Boolean);
  return {
    id: stringValue(thread.id),
    topic: stringValue(thread.topic),
    participant_ids: arrayValue(thread.participant_ids).map(stringValue).filter(Boolean),
    status: stringValue(thread.status) || "open",
    summary: stringValue(thread.summary),
    message_count: numberValue(thread.message_count) ?? messageIds.length,
    created_at: stringValue(thread.created_at),
    updated_at: stringValue(thread.updated_at),
    last_message_at: stringValue(thread.last_message_at),
  };
}

function messageSnapshot(message: JsonObject): JsonObject {
  return {
    id: stringValue(message.id),
    thread_id: stringValue(message.thread_id),
    sender_id: stringValue(message.sender_id),
    recipient_ids: arrayValue(message.recipient_ids).map(stringValue).filter(Boolean),
    content: stringValue(message.content),
    created_at: stringValue(message.created_at),
    read_by: arrayValue(message.read_by).map(stringValue).filter(Boolean),
  };
}

function mailboxSnapshot(record: JsonObject): JsonObject {
  return {
    id: stringValue(record.id),
    sender_id: stringValue(record.sender_id),
    recipient_ids: arrayValue(record.recipient_ids).map(stringValue).filter(Boolean),
    content: stringValue(record.content),
    visibility: stringValue(record.visibility) || "direct",
    kind: stringValue(record.kind) || "message",
    topic: stringValue(record.topic),
    event_type: stringValue(record.event_type),
    request_type: stringValue(record.request_type),
    status: stringValue(record.status) || "queued",
    thread_id: nullableString(record.thread_id),
    message_id: nullableString(record.message_id),
    requires_reply: record.requires_reply === true,
    priority: numberValue(record.priority) ?? 0,
    deadline_round: numberValue(record.deadline_round),
    correlation_id: nullableString(record.correlation_id),
    lineage_id: nullableString(record.lineage_id),
    reply_to_envelope_id: nullableString(record.reply_to_envelope_id),
    caused_by_envelope_id: nullableString(record.caused_by_envelope_id),
    expected_output_schema: isJsonObject(record.expected_output_schema) ? jsonSafeObject(record.expected_output_schema) : {},
    blocking_task_id: nullableString(record.blocking_task_id),
    escalate_after_rounds: numberValue(record.escalate_after_rounds),
    escalated_at: nullableString(record.escalated_at),
    read_by: arrayValue(record.read_by).map(stringValue).filter(Boolean),
    replied_by: arrayValue(record.replied_by).map(stringValue).filter(Boolean),
    created_at: stringValue(record.created_at),
    updated_at: stringValue(record.updated_at),
    delivered_at: nullableString(record.delivered_at),
  };
}

function eventSnapshot(event: JsonObject): JsonObject {
  return {
    id: stringValue(event.id),
    type: stringValue(event.type),
    message: stringValue(event.message),
    actor_id: nullableString(event.actor_id),
    data: isJsonObject(event.data) ? jsonSafeObject(event.data) : {},
    created_at: stringValue(event.created_at),
  };
}

function traceSpanSnapshot(span: JsonObject): JsonObject {
  return {
    id: stringValue(span.id),
    session_id: stringValue(span.session_id),
    run_id: nullableString(span.run_id),
    round_id: nullableString(span.round_id),
    parent_id: nullableString(span.parent_id),
    kind: stringValue(span.kind),
    name: stringValue(span.name),
    actor_id: nullableString(span.actor_id),
    status: stringValue(span.status) || "completed",
    started_at: stringValue(span.started_at),
    ended_at: nullableString(span.ended_at),
    duration_ms: numberValue(span.duration_ms),
    input_ref: stringValue(span.input_ref),
    output_ref: stringValue(span.output_ref),
    summary: stringValue(span.summary),
    data: isJsonObject(span.data) ? jsonSafeObject(span.data) : {},
    error: nullableString(span.error),
  };
}

function branchSnapshot(branch: CoworkBranch, current: boolean): JsonObject {
  return {
    id: branch.id,
    title: branch.title,
    architecture: branch.architecture,
    status: branch.status,
    topology_reference: jsonSafeObject(branch.topology_reference),
    source_branch_id: branch.source_branch_id,
    source_stage_record_id: branch.source_stage_record_id,
    derivation_event_id: branch.derivation_event_id,
    derivation_reason: branch.derivation_reason,
    inherited_context_summary: branch.inherited_context_summary,
    completion_decision: jsonSafeObject(branch.completion_decision),
    runtime_state: jsonSafeObject(branch.runtime_state),
    branch_result: branch.branch_result ? jsonSafeObject(branch.branch_result) : {},
    created_at: branch.created_at,
    updated_at: branch.updated_at,
    current,
    derived: Boolean(branch.source_branch_id),
  };
}

function budgetSnapshot(session: CoworkSession): JsonObject {
  const usage = { ...session.budget_usage, stop_reason: session.stop_reason || session.budget_usage.stop_reason || "" };
  return {
    limits: jsonSafeObject(session.budget_limits),
    usage: jsonSafeObject(usage),
    remaining: budgetRemaining(session.budget_limits, usage),
    stop_reason: stringValue(usage.stop_reason),
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
    const limitValue = numberValue(limit);
    const usageValue = numberValue(usage[usageKey]) ?? 0;
    remaining[limitKey] = limit === null || limitValue === null ? null : Math.max(0, limitValue - usageValue);
  }
  remaining.parallel_width = limits.parallel_width;
  return remaining;
}

function blueprintMetadata(blueprint: JsonObject): JsonObject {
  if (!Object.keys(blueprint).length) {
    return {};
  }
  return {
    id: stringValue(blueprint.id),
    schema_version: stringValue(blueprint.schema_version),
    lead_agent_id: stringValue(blueprint.lead_agent_id),
    agent_count: arrayValue(blueprint.agents).length,
    task_count: arrayValue(blueprint.tasks).length,
  };
}

function buildCoworkGraph(session: CoworkSession): JsonObject {
  const nodes: JsonObject[] = [{
    id: "session",
    kind: "session",
    label: session.title,
    title: session.title,
    detail: compact(session.current_focus_task || session.goal, 220),
    status: session.status,
    tone: statusTone(session.status),
    badge: session.workflow_mode,
    workflow_mode: session.workflow_mode,
    architecture: session.workflow_mode,
  }];
  const edges: JsonObject[] = [];

  nodes.push({
    id: "budget",
    kind: "budget",
    label: "Budget",
    title: "Budget",
    detail: `calls ${numberValue(session.budget_usage.agent_calls) ?? 0} / rounds ${numberValue(session.budget_usage.rounds) ?? 0}`,
    status: session.stop_reason.includes("budget") ? "blocked" : "active",
    badge: session.stop_reason || "limits",
  });
  addEdge(edges, "session", "budget", "has_budget");

  for (const agent of Object.values(session.agents)) {
    nodes.push({
      id: `agent:${agent.id}`,
      entity_id: agent.id,
      kind: "agent",
      label: agent.name,
      title: agent.name,
      detail: compact([agent.role, agent.current_task_title || agent.goal].filter(Boolean).join(" - "), 220),
      status: agent.status,
      tone: statusTone(agent.status),
      badge: `in ${agent.inbox.length} / r${agent.rounds}`,
      parent_agent_id: agent.parent_agent_id,
      team_id: agent.team_id,
      lifetime: agent.lifetime,
      lifecycle_status: agent.lifecycle_status,
      source_blueprint_id: agent.source_blueprint_id,
    });
    addEdge(edges, "session", `agent:${agent.id}`, "member");
    if (agent.parent_agent_id && session.agents[agent.parent_agent_id]) {
      addEdge(edges, `agent:${agent.parent_agent_id}`, `agent:${agent.id}`, "parent_of");
    }
  }

  for (const task of Object.values(session.tasks)) {
    nodes.push({
      id: `task:${task.id}`,
      entity_id: task.id,
      kind: "task",
      label: task.title,
      title: task.title,
      detail: compact(stringValue(task.result_data.answer) || task.result || task.description, 220),
      status: task.status,
      tone: statusTone(task.status),
      badge: task.assigned_agent_id || "shared",
      owner: task.assigned_agent_id,
      dependencies: [...task.dependencies],
      priority: task.priority,
      review_required: task.review_required,
      source_blueprint_id: task.source_blueprint_id,
    });
    addEdge(edges, "session", `task:${task.id}`, "has_task");
    if (task.assigned_agent_id && session.agents[task.assigned_agent_id]) {
      addEdge(edges, `task:${task.id}`, `agent:${task.assigned_agent_id}`, "assigned_to");
    }
    for (const dependency of task.dependencies) {
      if (session.tasks[dependency]) {
        addEdge(edges, `task:${dependency}`, `task:${task.id}`, "depends_on");
      }
    }
  }

  for (const thread of Object.values(session.threads)) {
    const id = stringValue(thread.id);
    nodes.push({
      id: `thread:${id}`,
      entity_id: id,
      kind: "thread",
      label: stringValue(thread.topic),
      title: stringValue(thread.topic),
      detail: stringValue(thread.summary),
      status: stringValue(thread.status) || "open",
      badge: `${arrayValue(thread.message_ids).length} msg`,
    });
    addEdge(edges, "session", `thread:${id}`, "has_thread");
  }

  for (const record of Object.values(session.mailbox)) {
    const id = stringValue(record.id);
    nodes.push({
      id: `mailbox:${id}`,
      entity_id: id,
      kind: "mailbox",
      label: stringValue(record.request_type) || stringValue(record.kind) || "mailbox",
      title: stringValue(record.request_type) || stringValue(record.kind) || "Mailbox",
      detail: compact(record.content, 220),
      status: stringValue(record.status) || "queued",
      badge: record.requires_reply === true ? "reply" : stringValue(record.kind),
      sender_id: stringValue(record.sender_id),
      recipient_ids: arrayValue(record.recipient_ids),
    });
    const sender = session.agents[stringValue(record.sender_id)] ? `agent:${stringValue(record.sender_id)}` : "session";
    addEdge(edges, sender, `mailbox:${id}`, "sent");
    for (const recipient of arrayValue(record.recipient_ids).map(stringValue)) {
      if (session.agents[recipient]) {
        addEdge(edges, `mailbox:${id}`, `agent:${recipient}`, "delivered_to", {
          pulse: record.requires_reply === true,
          status: stringValue(record.status),
        });
      }
    }
  }

  for (const artifact of buildCoworkArtifactIndex(session)) {
    nodes.push({
      id: stringValue(artifact.id).replace(/^artifact_/, "artifact:"),
      kind: "artifact",
      label: compact(artifact.path_or_url, 70),
      title: stringValue(artifact.path_or_url),
      detail: stringValue(artifact.path_or_url),
      status: "completed",
      badge: stringValue(artifact.kind),
      source_task_id: artifact.source_task_id,
      source_agent_id: artifact.source_agent_id,
    });
    if (typeof artifact.source_task_id === "string" && session.tasks[artifact.source_task_id]) {
      addEdge(edges, `task:${artifact.source_task_id}`, stringValue(artifact.id).replace(/^artifact_/, "artifact:"), "produced");
    }
  }

  return {
    schema_version: "cowork.graph.v2",
    generated_at: generatedAt(),
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      total_nodes: nodes.length,
      total_edges: edges.length,
      hidden_nodes: 0,
      hidden_edges: 0,
      node_kinds: countBy(nodes, "kind"),
      edge_kinds: countBy(edges, "kind"),
      total_node_kinds: countBy(nodes, "kind"),
      total_edge_kinds: countBy(edges, "kind"),
      agents: Object.keys(session.agents).length,
      total_agents: Object.keys(session.agents).length,
      tasks: Object.keys(session.tasks).length,
      threads: Object.keys(session.threads).length,
      mailbox: Object.keys(session.mailbox).length,
      artifacts: buildCoworkArtifactIndex(session).length,
    },
    truncated: { nodes: false, edges: false, hidden_nodes: 0, hidden_edges: 0, limits: { nodes: 160, edges: 260 } },
  };
}

function buildCoworkTrace(session: CoworkSession): JsonObject[] {
  return session.events.slice(-80).map((event) => {
    const data = isJsonObject(event.data) ? event.data : {};
    const actorId = event.actor_id || stringValue(data.agent_id);
    const taskId = stringValue(data.task_id || data.blocking_task_id);
    return {
      id: event.id,
      type: event.type,
      stage: eventStage(event.type),
      action: eventAction(event.type),
      detail: event.message,
      actor_id: actorId || null,
      actor_name: actorId && session.agents[actorId] ? session.agents[actorId].name : null,
      at: stringValue(event.created_at),
      status: statusTone(stringValue(data.status) || lastSegment(event.type) || ""),
      node_id: actorId && session.agents[actorId] ? `agent:${actorId}` : "session",
      next_node_id: taskId && session.tasks[taskId] ? `task:${taskId}` : "",
      payload: jsonSafeObject(data),
      source: "event",
    };
  });
}

function buildCoworkTaskDag(session: CoworkSession): JsonObject {
  const nodes: JsonObject[] = [{
    id: "goal",
    kind: "goal",
    label: session.title,
    title: session.title,
    detail: compact(session.goal, 260),
    status: session.status,
    tone: statusTone(session.status),
  }];
  const edges: JsonObject[] = [];
  for (const task of Object.values(session.tasks)) {
    nodes.push({
      id: `task:${task.id}`,
      entity_id: task.id,
      kind: "task",
      label: task.title,
      title: task.title,
      detail: compact(stringValue(task.result_data.answer) || task.result || task.description, 260),
      status: task.status,
      tone: statusTone(task.status),
      owner: task.assigned_agent_id,
      confidence: task.confidence,
      updated_at: task.updated_at,
    });
    if (task.dependencies.length) {
      task.dependencies.forEach((dependency) => addEdge(edges, session.tasks[dependency] ? `task:${dependency}` : "goal", `task:${task.id}`, session.tasks[dependency] ? "depends_on" : "root"));
    } else {
      addEdge(edges, "goal", `task:${task.id}`, "root");
    }
    if (task.assigned_agent_id && session.agents[task.assigned_agent_id]) {
      const agent = session.agents[task.assigned_agent_id];
      const agentNodeId = `agent:${agent.id}`;
      if (!nodes.some((node) => node.id === agentNodeId)) {
        nodes.push({
          id: agentNodeId,
          entity_id: agent.id,
          kind: "agent",
          label: agent.name,
          title: agent.name,
          detail: compact(agent.role, 120),
          status: agent.status,
          tone: statusTone(agent.status),
        });
      }
      addEdge(edges, agentNodeId, `task:${task.id}`, "owns");
    }
    for (const artifact of taskArtifacts(task)) {
      const artifactId = `artifact:${hash(`${task.id}:${artifact}`)}`;
      nodes.push({
        id: artifactId,
        kind: "artifact",
        label: compact(artifact, 80),
        title: artifact,
        detail: artifact,
        status: "completed",
        tone: "completed",
        source_task_id: task.id,
      });
      addEdge(edges, `task:${task.id}`, artifactId, "produced");
    }
  }
  return {
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      tasks: Object.keys(session.tasks).length,
      blocked_tasks: 0,
      artifacts: nodes.filter((node) => node.kind === "artifact").length,
    },
  };
}

function buildCoworkArtifactIndex(session: CoworkSession): JsonObject[] {
  const artifacts: JsonObject[] = [];
  const seen = new Set<string>();
  for (const task of Object.values(session.tasks)) {
    for (const artifact of taskArtifacts(task)) {
      const key = artifactKey(artifact);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      artifacts.push(artifactRecord(artifacts.length + 1, artifact, {
        source_agent_id: task.assigned_agent_id,
        source_task_id: task.id,
        source_task_title: task.title,
        created_at: task.updated_at,
        summary: compact(artifact, 160),
        confidence: task.confidence,
      }));
    }
  }
  for (const artifact of session.artifacts) {
    const key = artifactKey(artifact);
    if (!artifact.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    artifacts.push(artifactRecord(artifacts.length + 1, artifact, {
      source_agent_id: null,
      source_task_id: null,
      source_task_title: "",
      created_at: session.updated_at,
      summary: compact(artifact, 160),
      confidence: null,
    }));
  }
  return artifacts;
}

function artifactRecord(index: number, pathOrUrl: string, extra: JsonObject): JsonObject {
  return {
    id: `artifact_${index}`,
    path_or_url: pathOrUrl,
    kind: artifactKind(pathOrUrl),
    status: "available",
    ...extra,
  };
}

function taskArtifacts(task: CoworkTask): string[] {
  const values: string[] = [];
  for (const key of ["artifacts", "artifact_paths", "generated_files", "files", "paths"]) {
    const raw = task.result_data[key];
    if (Array.isArray(raw)) {
      values.push(...raw.map(stringValue));
    } else if (typeof raw === "string") {
      values.push(raw);
    }
  }
  return values.map((item) => item.trim()).filter(Boolean);
}

function redactedSensitiveArtifacts(input: Record<string, JsonObject>): JsonObject {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...jsonSafeObject(value), redacted: true }]));
}

function orchestrationAssessment(swarmPlan: JsonObject): JsonObject {
  return isJsonObject(swarmPlan.orchestration) ? jsonSafeObject(swarmPlan.orchestration) : {};
}

function buildSwarmSchedulerQueues(session: CoworkSession): JsonObject {
  const plan = jsonSafeObject(session.swarm_plan);
  const units = swarmWorkUnits(session);
  const completed = completedSwarmReferences(session, units);
  const runningAgents = new Set(units
    .filter((unit) => stringValue(unit.status) === "in_progress" && stringValue(unit.assigned_agent_id))
    .map((unit) => stringValue(unit.assigned_agent_id)));
  const queues: Record<string, JsonObject[]> = {
    ready: [],
    blocked: [],
    running: [],
    completed: [],
    failed_retry: [],
    cancelled: [],
  };
  for (const unit of units) {
    const item = swarmQueueItem(unit, completed, runningAgents);
    const status = stringValue(unit.status) || "pending";
    if (status === "in_progress") {
      queues.running.push(item);
    } else if (["completed", "skipped"].includes(status)) {
      queues.completed.push(item);
    } else if (["failed", "needs_revision"].includes(status)) {
      const attempts = Math.trunc(numberValue(unit.attempts) ?? 0);
      const maxAttempts = Math.trunc(numberValue(unit.max_attempts) ?? 1);
      if (attempts < maxAttempts) {
        queues.failed_retry.push(item);
      } else {
        item.block_reason = "max_attempts_reached";
        queues.blocked.push(item);
      }
    } else if (status === "cancelled") {
      queues.cancelled.push(item);
    } else if (arrayValue(item.blocked_by).length > 0) {
      queues.blocked.push(item);
    } else {
      queues.ready.push(item);
    }
  }
  for (const key of Object.keys(queues)) {
    queues[key] = sortSwarmQueueItems(queues[key] ?? []);
  }
  queues.ready = fairOrderSwarmQueueByWorkstream(queues.ready);
  queues.failed_retry = fairOrderSwarmQueueByWorkstream(queues.failed_retry);
  const metrics = buildSwarmParallelMetrics(session);
  const parallelWidth = Math.max(1, Math.trunc(numberValue(session.budget_limits.parallel_width) ?? 1));
  return {
    schema_version: "cowork.swarm_queues.v1",
    plan_id: stringValue(plan.id),
    plan_status: stringValue(plan.status),
    generated_at: generatedAt(),
    parallel_width: parallelWidth,
    available_slots: Math.max(0, parallelWidth - queues.running.length),
    queues,
    counts: Object.fromEntries(Object.entries(queues).map(([key, value]) => [key, value.length])),
    budget: {
      limits: jsonSafeObject(session.budget_limits),
      usage: jsonSafeObject(session.budget_usage),
    },
    metrics,
  };
}

function buildSwarmParallelMetrics(session: CoworkSession): JsonObject {
  const plan = jsonSafeObject(session.swarm_plan);
  const units = swarmWorkUnits(session);
  const mainUnits = units.filter((unit) => !["reducer", "reviewer"].includes(stringValue(unit.kind)));
  const requiredUnits = mainUnits.filter((unit) => stringValue(unit.status) !== "cancelled");
  const completedUnits = requiredUnits.filter((unit) => stringValue(unit.status) === "completed");
  const runningUnits = requiredUnits.filter((unit) => stringValue(unit.status) === "in_progress");
  const blockedUnits = requiredUnits.filter((unit) => {
    const status = stringValue(unit.status);
    return ["failed", "blocked", "needs_revision"].includes(status) || metricBlockedBy(unit, units, session).length > 0;
  });
  const runnableUnits = requiredUnits.filter((unit) => {
    const status = stringValue(unit.status) || "pending";
    return ["ready", "pending"].includes(status) && metricBlockedBy(unit, units, session).length === 0;
  });
  const reducerUnits = units.filter((unit) => stringValue(unit.kind) === "reducer");
  const reviewerUnits = units.filter((unit) => stringValue(unit.kind) === "reviewer");
  const parallelWidth = Math.max(1, Math.trunc(numberValue(session.budget_limits.parallel_width) ?? 1));
  const depth = criticalPathDepth(units);
  const totalCriticalPathDepth = depth + (reducerUnits.length > 0 ? 1 : 0) + (reviewerUnits.length > 0 ? 1 : 0);
  const rounds = Math.max(1, Math.trunc(numberValue(session.rounds) ?? 0) || totalCriticalPathDepth || 1);
  const observedWidth = Math.max(
    runningUnits.length,
    observedWidthFromTrace(session.trace_spans),
    runnableUnits.length > 1 ? Math.min(parallelWidth, runnableUnits.length) : 0,
  );
  const duplicateRejections = session.events.filter((event) => event.type === "swarm.duplicate_activation_skipped").length;
  const blockedSlotCount = Math.max(0, Math.min(parallelWidth, blockedUnits.length) - runningUnits.length);
  return {
    schema_version: "cowork.swarm_metrics.v1",
    plan_id: stringValue(plan.id),
    critical_path_depth: totalCriticalPathDepth,
    critical_rounds: rounds,
    fanout_width_observed: observedWidth,
    parallel_efficiency: roundRatio(completedUnits.length / Math.max(1, totalCriticalPathDepth || rounds)),
    fanout_utilization: roundRatio(observedWidth / parallelWidth),
    duplicate_rejection_count: duplicateRejections,
    blocked_slot_count: blockedSlotCount,
    reducer_coverage: roundRatio(reducerCoverage(session, completedUnits)),
    counts: {
      work_units: requiredUnits.length,
      completed: completedUnits.length,
      running: runningUnits.length,
      blocked: blockedUnits.length,
      reducer_units: reducerUnits.length,
      reviewer_units: reviewerUnits.length,
    },
    generated_at: generatedAt(),
  };
}

function swarmQueueItem(unit: JsonObject, completed: Set<string>, runningAgents: Set<string>): JsonObject {
  const dependencies = arrayValue(unit.dependencies).map(stringValue).filter((item) => item.trim());
  const blockedBy = dependencies.filter((dependency) => !completed.has(dependency));
  const attempts = Math.trunc(numberValue(unit.attempts) ?? 0);
  const maxAttempts = Math.trunc(numberValue(unit.max_attempts) ?? 1);
  return {
    id: stringValue(unit.id),
    title: stringValue(unit.title),
    status: stringValue(unit.status) || "pending",
    priority: Math.trunc(numberValue(unit.priority) ?? 0),
    assigned_agent_id: stringValue(unit.assigned_agent_id) || null,
    dependencies,
    blocked_by: blockedBy,
    attempts,
    max_attempts: maxAttempts,
    workstream: stringValue(unit.team_id) || stringValue(unit.fanout_group_id) || stringValue(unit.kind) || "default",
    created_at: stringValue(unit.created_at),
    updated_at: stringValue(unit.updated_at),
    reason: swarmQueueReason(unit, blockedBy, runningAgents),
  };
}

function swarmQueueReason(unit: JsonObject, blockedBy: string[], runningAgents: Set<string>): string {
  if (blockedBy.length > 0) {
    return `Waiting on dependencies: ${blockedBy.join(", ")}`;
  }
  const status = stringValue(unit.status) || "pending";
  if (status === "in_progress") {
    return `Running on ${stringValue(unit.assigned_agent_id) || "an agent"}`;
  }
  if (["failed", "needs_revision"].includes(status)) {
    const attempts = Math.trunc(numberValue(unit.attempts) ?? 0);
    const maxAttempts = Math.trunc(numberValue(unit.max_attempts) ?? 1);
    return attempts < maxAttempts ? "Eligible for retry" : "Retry budget exhausted";
  }
  if (runningAgents.has(stringValue(unit.assigned_agent_id))) {
    return "Owner is already running another work unit";
  }
  return "Dependencies satisfied and scheduling budget permitting";
}

function completedSwarmReferences(session: CoworkSession, units: JsonObject[]): Set<string> {
  return new Set([
    ...units
      .filter((unit) => ["completed", "skipped"].includes(stringValue(unit.status)))
      .map((unit) => stringValue(unit.id)),
    ...Object.values(session.tasks)
      .filter((task) => ["completed", "skipped"].includes(task.status))
      .map((task) => task.id),
  ].filter(Boolean));
}

function sortSwarmQueueItems(items: JsonObject[]): JsonObject[] {
  return [...items].sort((left, right) => (numberValue(right.priority) ?? 0) - (numberValue(left.priority) ?? 0)
    || stringValue(left.created_at).localeCompare(stringValue(right.created_at))
    || stringValue(left.id).localeCompare(stringValue(right.id)));
}

function fairOrderSwarmQueueByWorkstream(items: JsonObject[]): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const item of items) {
    const workstream = stringValue(item.workstream) || "default";
    const group = groups.get(workstream) ?? [];
    group.push(item);
    groups.set(workstream, group);
  }
  const ordered: JsonObject[] = [];
  while ([...groups.values()].some((group) => group.length > 0)) {
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key);
      const item = group?.shift();
      if (item) {
        ordered.push(item);
      }
    }
  }
  return ordered;
}

function metricBlockedBy(unit: JsonObject, units: JsonObject[], session: CoworkSession): string[] {
  const completed = completedSwarmReferences(session, units);
  return arrayValue(unit.dependencies).map(stringValue).filter((dependency) => dependency && !completed.has(dependency));
}

function criticalPathDepth(units: JsonObject[]): number {
  const byId = new Map(units.map((unit) => [stringValue(unit.id), unit]));
  const memo = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (!id) {
      return 0;
    }
    if (seen.has(id)) {
      return 1;
    }
    const existing = memo.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const unit = byId.get(id);
    if (!unit) {
      return 0;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const depth = 1 + Math.max(0, ...arrayValue(unit.dependencies).map((dependency) => visit(stringValue(dependency), nextSeen)));
    memo.set(id, depth);
    return depth;
  };
  return Math.max(0, ...units.map((unit) => visit(stringValue(unit.id), new Set())));
}

function observedWidthFromTrace(traceSpans: JsonObject[]): number {
  return new Set(traceSpans
    .filter((span) => stringValue(span.name) === "Work unit started")
    .map((span) => {
      const data = isJsonObject(span.data) ? jsonSafeObject(span.data) : {};
      return stringValue(data.work_unit_id);
    })
    .filter(Boolean)).size;
}

function reducerCoverage(session: CoworkSession, completedUnits: JsonObject[]): number {
  if (completedUnits.length === 0) {
    return 0;
  }
  const reducerIds = new Set(Object.values(session.tasks)
    .filter((task) => stringValue(task.source_event_id).startsWith("swarm_reducer:"))
    .flatMap((task) => arrayValue(task.result_data.source_work_unit_ids).map(stringValue).filter(Boolean)));
  if (reducerIds.size === 0) {
    return 0;
  }
  const covered = completedUnits.filter((unit) => reducerIds.has(stringValue(unit.id))).length;
  return covered / completedUnits.length;
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function buildCoworkLargeSwarmSummary(session: CoworkSession): JsonObject {
  const units = swarmWorkUnits(session);
  const groups = new Map<string, {
    id: string;
    title: string;
    count: number;
    statusCounts: Record<string, number>;
    sampleUnitIds: string[];
  }>();
  for (const unit of units) {
    const groupId = stringValue(unit.team_id) || stringValue(unit.fanout_group_id) || stringValue(unit.kind) || "default";
    const group = groups.get(groupId) ?? {
      id: groupId,
      title: groupId.replace(/_/g, " "),
      count: 0,
      statusCounts: {},
      sampleUnitIds: [],
    };
    const status = stringValue(unit.status) || "unknown";
    group.count += 1;
    group.statusCounts[status] = (group.statusCounts[status] ?? 0) + 1;
    if (group.sampleUnitIds.length < 8) {
      group.sampleUnitIds.push(stringValue(unit.id));
    }
    groups.set(groupId, group);
  }
  return {
    schema_version: "cowork.large_swarm.v1",
    enabled: units.length >= 40,
    total_work_units: units.length,
    status_counts: countBy(units, "status"),
    workstreams: [...groups.values()]
      .sort((left, right) => right.count - left.count)
      .map((group) => ({
        id: group.id,
        title: group.title,
        count: group.count,
        status_counts: sortRecord(group.statusCounts),
        sample_unit_ids: group.sampleUnitIds.filter(Boolean),
      })),
    render_limit: 60,
    generated_at: generatedAt(),
  };
}

function buildCoworkSwarmOrganization(session: CoworkSession): JsonObject {
  const plan = jsonSafeObject(session.swarm_plan);
  const units = swarmWorkUnits(session);
  const mainUnits = units.filter((unit) => !["reducer", "reviewer"].includes(stringValue(unit.kind)));
  const metrics = session.workflow_mode === "swarm" ? buildSwarmParallelMetrics(session) : {};
  const workstreams = swarmWorkstreamGroups(mainUnits);
  return {
    schema_version: "cowork.swarm_organization.v1",
    generated_at: generatedAt(),
    plan_id: stringValue(plan.id),
    plan_status: stringValue(plan.status),
    enabled: units.length > 0 && (units.length >= 20 || workstreams.length > 1),
    total_work_units: units.length,
    workstreams,
    grouped_counts: {
      workstreams: workstreams.length,
      work_units: mainUnits.length,
      gates: units.filter((unit) => ["reducer", "reviewer"].includes(stringValue(unit.kind))).length,
      agents: new Set(units.map((unit) => stringValue(unit.assigned_agent_id)).filter(Boolean)).size,
    },
    gates: swarmGateSummary(plan, units, session),
    metrics,
    blockers: swarmBlockerSummaries(units, session),
  };
}

function swarmWorkstreamGroups(units: JsonObject[]): JsonObject[] {
  const groups = new Map<string, {
    id: string;
    title: string;
    unitCounts: Record<string, number>;
    agentIds: Set<string>;
    blockers: JsonObject[];
    sampleUnitIds: string[];
    critical: boolean;
  }>();
  for (const unit of units) {
    const groupId = swarmWorkstreamId(unit);
    const group = groups.get(groupId) ?? {
      id: groupId,
      title: swarmWorkstreamTitle(groupId, unit),
      unitCounts: {},
      agentIds: new Set<string>(),
      blockers: [],
      sampleUnitIds: [],
      critical: false,
    };
    const status = stringValue(unit.status) || "unknown";
    group.unitCounts[status] = (group.unitCounts[status] ?? 0) + 1;
    const agentId = stringValue(unit.assigned_agent_id);
    if (agentId) {
      group.agentIds.add(agentId);
    }
    if (group.sampleUnitIds.length < 8) {
      group.sampleUnitIds.push(stringValue(unit.id));
    }
    const blockers = workUnitBlockers(unit);
    if (blockers.length > 0) {
      group.blockers.push({
        work_unit_id: stringValue(unit.id),
        blocked_by: blockers,
        status,
      });
    }
    if (["failed", "blocked", "needs_revision"].includes(status)) {
      group.critical = true;
    }
    groups.set(groupId, group);
  }
  return [...groups.values()]
    .map((group) => {
      const total = Object.values(group.unitCounts).reduce((sum, value) => sum + value, 0);
      const completed = (group.unitCounts.completed ?? 0) + (group.unitCounts.skipped ?? 0);
      const blocked = (group.unitCounts.failed ?? 0) + (group.unitCounts.blocked ?? 0) + (group.unitCounts.needs_revision ?? 0);
      const running = group.unitCounts.in_progress ?? 0;
      const status = blocked > 0 ? "blocked" : running > 0 ? "active" : total > 0 && completed === total ? "completed" : "pending";
      const risk = blocked > 0 ? "high" : status !== "completed" && group.blockers.length > 0 ? "medium" : "low";
      return {
        id: group.id,
        title: group.title,
        status,
        unit_counts: sortRecord(group.unitCounts),
        agent_ids: [...group.agentIds].sort(),
        critical: group.critical || blocked > 0,
        coverage: Math.round((completed / Math.max(1, total)) * 1000) / 1000,
        risk,
        blockers: group.blockers,
        sample_unit_ids: group.sampleUnitIds.filter(Boolean),
      };
    })
    .sort((left, right) => {
      const leftCount = Object.values(jsonSafeObject(left.unit_counts)).reduce<number>((sum, value) => sum + (numberValue(value) ?? 0), 0);
      const rightCount = Object.values(jsonSafeObject(right.unit_counts)).reduce<number>((sum, value) => sum + (numberValue(value) ?? 0), 0);
      return rightCount - leftCount || stringValue(left.id).localeCompare(stringValue(right.id));
    });
}

function swarmGateSummary(plan: JsonObject, units: JsonObject[], session: CoworkSession): JsonObject {
  const evaluations = Array.isArray(session.runtime_state.swarm_evaluations)
    ? session.runtime_state.swarm_evaluations.filter(isJsonObject).map(jsonSafeObject)
    : [];
  const blockingEvaluations = evaluations.filter((item) => ["block", "error"].includes(stringValue(item.status)));
  return {
    reducer: swarmGate("reducer", units.filter((unit) => stringValue(unit.kind) === "reducer"), plan.reducer),
    reviewer: swarmGate("reviewer", units.filter((unit) => stringValue(unit.kind) === "reviewer"), plan.review),
    evaluations: {
      status: blockingEvaluations.length > 0 ? "blocked" : evaluations.length > 0 ? "pass" : "not_ready",
      total: evaluations.length,
      blocking: blockingEvaluations.length,
      blocking_ids: blockingEvaluations.map((item) => stringValue(item.id)),
    },
    final_deliverable: {
      status: session.completion_decision.ready_to_finish === true ? "ready" : "not_ready",
      next_action: stringValue(session.completion_decision.next_action),
      reason: stringValue(session.completion_decision.reason),
    },
  };
}

function swarmGate(kind: string, units: JsonObject[], config: unknown): JsonObject {
  const unit = units[units.length - 1] ?? {};
  const data = isJsonObject(config) ? jsonSafeObject(config) : {};
  const required = Boolean(data.required) || kind === "reducer";
  return {
    status: stringValue(unit.status) || (required ? "pending" : "not_ready"),
    required,
    agent_id: stringValue(unit.assigned_agent_id) || stringValue(data.agent_id),
    work_unit_id: stringValue(unit.id),
    source_work_unit_ids: arrayValue(unit.source_work_unit_ids).map(stringValue).filter(Boolean),
    source_artifact_refs: arrayValue(unit.source_artifact_refs).map(stringValue).filter(Boolean),
    coverage_by_workstream: isJsonObject(unit.coverage_by_workstream) ? jsonSafeObject(unit.coverage_by_workstream) : {},
    confidence_by_section: isJsonObject(unit.confidence_by_section) ? jsonSafeObject(unit.confidence_by_section) : {},
  };
}

function swarmBlockerSummaries(units: JsonObject[], session: CoworkSession): JsonObject[] {
  const completed = new Set([
    ...units.filter((unit) => ["completed", "skipped", "cancelled"].includes(stringValue(unit.status))).map((unit) => stringValue(unit.id)),
    ...Object.values(session.tasks)
      .filter((task) => ["completed", "skipped"].includes(task.status))
      .map((task) => task.id),
  ].filter(Boolean));
  const blockers: JsonObject[] = [];
  for (const unit of units) {
    const blockedBy = workUnitBlockers(unit).filter((item) => !completed.has(item));
    const status = stringValue(unit.status);
    if (blockedBy.length === 0 && !["failed", "blocked", "needs_revision"].includes(status)) {
      continue;
    }
    blockers.push({
      work_unit_id: stringValue(unit.id),
      title: stringValue(unit.title),
      workstream_id: swarmWorkstreamId(unit),
      status,
      blocked_by: blockedBy,
      error: stringValue(unit.error),
    });
  }
  return blockers.slice(0, 40);
}

function swarmWorkUnits(session: CoworkSession): JsonObject[] {
  return arrayValue(session.swarm_plan.work_units).filter(isJsonObject).map(jsonSafeObject);
}

function swarmWorkstreamId(unit: JsonObject): string {
  for (const key of ["workstream_id", "workstream", "fanout_group_id", "team_id", "source_kind", "kind"]) {
    const value = stringValue(unit[key]).trim();
    if (value) {
      return value;
    }
  }
  return stringValue(unit.source_task_id) || "default";
}

function swarmWorkstreamTitle(groupId: string, unit: JsonObject): string {
  const title = stringValue(unit.workstream_title) || stringValue(unit.fanout_group_title);
  return title || groupId.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function workUnitBlockers(unit: JsonObject): string[] {
  return [
    ...arrayValue(unit.blocked_by),
    ...arrayValue(unit.dependencies),
  ].map(stringValue).filter((item) => item.trim().length > 0);
}

function addEdge(edges: JsonObject[], source: string, target: string, kind: string, extra: JsonObject = {}): void {
  if (!source || !target || source === target) {
    return;
  }
  if (edges.some((edge) => edge.from === source && edge.to === target && edge.kind === kind)) {
    return;
  }
  edges.push({ from: source, to: target, source, target, kind, ...extra });
}

function countBy(items: JsonObject[], key: string): JsonObject {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = stringValue(item[key]) || "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sortRecord(input: Record<string, number>): JsonObject {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (["completed", "done", "replied"].includes(value)) {
    return "completed";
  }
  if (["failed", "blocked", "expired"].includes(value)) {
    return "failed";
  }
  if (["working", "in_progress", "active"].includes(value)) {
    return "active";
  }
  if (["waiting", "queued", "delivered", "read", "pending", "paused"].includes(value)) {
    return "pending";
  }
  return "idle";
}

function eventStage(type: string): string {
  if (type.startsWith("scheduler.")) return "scheduler";
  if (type.startsWith("agent.")) return "agent";
  if (type.startsWith("task.")) return "task";
  if (type.startsWith("mailbox.") || type.startsWith("message.")) return "message";
  if (type.startsWith("session.")) return "session";
  return "event";
}

function eventAction(type: string): string {
  const labels: Record<string, string> = {
    "session.created": "Session created",
    "scheduler.round": "Scheduler round",
    "scheduler.idle": "Scheduler idle",
    "scheduler.lead_synthesis": "Lead synthesis",
    "agent.started": "Agent started",
    "agent.ran": "Agent finished",
    "agent.failed": "Agent failed",
    "task.added": "Task added",
    "task.assigned": "Task assigned",
    "task.completed": "Task completed",
    "mailbox.delivered": "Mailbox delivered",
    "mailbox.read": "Mailbox read",
  };
  return labels[type] ?? type.replace(/\./g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function lastSegment(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? "";
}

function artifactKey(value: string): string {
  return value.trim().toLowerCase();
}

function artifactKind(value: string): string {
  const text = value.toLowerCase();
  if (/^https?:\/\//.test(text)) return "url";
  if (text.endsWith(".md")) return "markdown";
  if (text.endsWith(".json")) return "json";
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(text)) return "image";
  return "file";
}

function hash(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

function compact(value: unknown, limit: number): string {
  const text = stringValue(value).split(/\s+/).filter(Boolean).join(" ");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function generatedAt(): string {
  return new Date().toISOString();
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return stringValue(value);
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
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
