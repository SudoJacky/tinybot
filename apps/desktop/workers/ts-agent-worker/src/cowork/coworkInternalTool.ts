import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { Tool, ToolDefinition, ToolResult } from "../tools/tool.ts";
import { normalizeCoworkSession } from "./coworkSerde.ts";
import type { CoworkAgent, CoworkEvent, CoworkSession, CoworkTask } from "./coworkTypes.ts";
import type { CoworkIdGenerator, CoworkServiceStore } from "./coworkService.ts";

export type CoworkInternalToolOptions = {
  store: CoworkServiceStore;
  sessionId: string;
  senderId: string;
  now?: () => string;
  idGenerator?: CoworkIdGenerator;
};

export function coworkInternalToolDefinition(): ToolDefinition {
  return {
    name: "cowork_internal",
    description: "Coordinate with other cowork agents. Use it to send messages, create discussion threads, add follow-up tasks, update your status, or mark an assigned task complete.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send_message", "create_thread", "complete_task", "assign_task", "claim_task", "add_task", "spawn_agent", "spawn_subteam", "retire_agent", "update_status"],
          description: "Internal cowork action to perform.",
        },
        recipient_ids: {
          type: "array",
          items: { type: "string" },
          description: "Message recipients. Defaults to group message routing.",
        },
        thread_id: {
          type: "string",
          description: "Thread id for a message. Defaults to the first session thread.",
        },
        topic: {
          type: "string",
          description: "Thread topic for create_thread.",
        },
        title: {
          type: "string",
          description: "Task title for add_task.",
        },
        description: {
          type: "string",
          description: "Task description for add_task.",
        },
        assigned_agent_id: {
          type: "string",
          description: "Agent id to assign a task or retire an agent.",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Task dependencies for add_task.",
        },
        task_id: {
          type: "string",
          description: "Task id to complete. Defaults to the sender agent's current task.",
        },
        content: {
          type: "string",
          description: "Task completion result or note.",
        },
        status: {
          type: "string",
          enum: ["idle", "working", "waiting", "blocked", "done", "failed", "completed", "skipped"],
          description: "Completion or agent status.",
        },
        role: {
          type: "string",
          description: "Role for a spawned agent.",
        },
        goal: {
          type: "string",
          description: "Goal for a spawned agent.",
        },
        responsibilities: {
          type: "array",
          items: { type: "string" },
          description: "Spawned agent responsibilities.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Spawned agent tool allowlist.",
        },
        subscriptions: {
          type: "array",
          items: { type: "string" },
          description: "Spawned agent subscriptions.",
        },
        team_id: {
          type: "string",
          description: "Subteam id for a spawned agent.",
        },
        work_unit_id: {
          type: "string",
          description: "Swarm work-unit id that caused a spawned agent.",
        },
        agents: {
          type: "array",
          items: { type: "object" },
          description: "Subteam agent specs for spawn_subteam.",
        },
        tasks: {
          type: "array",
          items: { type: "object" },
          description: "Subteam task specs for spawn_subteam.",
        },
      },
      required: ["action"],
      additionalProperties: true,
    },
  };
}

export function createCoworkInternalTool(options: CoworkInternalToolOptions): Tool {
  const now = options.now ?? (() => new Date().toISOString());
  const idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  return {
    ...coworkInternalToolDefinition(),
    async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
      const traceId = context.traceId ?? "";
      const session = await options.store.readSnapshot(options.sessionId, traceId);
      if (!session) {
        return { content: `Error: cowork session '${options.sessionId}' not found` };
      }
      const agent = session.agents[options.senderId];
      if (!agent) {
        return { content: `Error: sender '${options.senderId}' not found` };
      }
      const action = cleanString(args.action);
      if (action === "create_thread") {
        const thread = createThread(session, agent.id, {
          topic: cleanString(args.topic) || "Discussion",
          participantIds: stringList(args.recipient_ids),
        }, now, idGenerator);
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Created thread ${thread.id}: ${thread.topic}`,
          metadata: internalMetadata(session.id, agent.id, action, { thread_id: thread.id }),
        };
      }
      if (action === "send_message") {
        const content = cleanString(args.content);
        if (!content) {
          return { content: "Error: content is required" };
        }
        const message = sendMessage(session, agent.id, {
          content,
          recipientIds: stringList(args.recipient_ids),
          threadId: cleanString(args.thread_id),
        }, now, idGenerator);
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Sent message ${message.id}`,
          metadata: internalMetadata(session.id, agent.id, action, { message_id: message.id }),
        };
      }
      if (action === "add_task") {
        const title = cleanString(args.title);
        if (!title) {
          return { content: "Error: title is required" };
        }
        const task = addTask(session, agent, {
          title,
          description: cleanString(args.description) || title,
          assignedAgentId: cleanString(args.assigned_agent_id),
          dependencies: stringList(args.dependencies),
          fanoutGroupId: "",
          mergeTaskId: "",
          sourceEventId: "",
        }, now, idGenerator);
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Added task ${task.id}: ${task.title}`,
          metadata: internalMetadata(session.id, agent.id, action, { task_id: task.id }),
        };
      }
      if (action === "assign_task") {
        const taskId = cleanString(args.task_id);
        if (!taskId) {
          return { content: "Error: task_id is required" };
        }
        const assignedAgentId = cleanString(args.assigned_agent_id);
        if (!assignedAgentId) {
          return { content: "Error: assigned_agent_id is required" };
        }
        const assigned = assignTask(session, agent, taskId, assignedAgentId, now, idGenerator);
        if (typeof assigned === "string") {
          return { content: assigned };
        }
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Assigned task ${assigned.task.id} to ${assigned.agent.id}`,
          metadata: internalMetadata(session.id, agent.id, action, {
            task_id: assigned.task.id,
            assigned_agent_id: assigned.agent.id,
          }),
        };
      }
      if (action === "claim_task") {
        const claimed = claimTask(session, agent, cleanString(args.task_id), now, idGenerator);
        if (typeof claimed === "string") {
          await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
          return {
            content: claimed,
            metadata: internalMetadata(session.id, agent.id, action),
          };
        }
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Claimed task ${claimed.id}: ${claimed.title}`,
          metadata: internalMetadata(session.id, agent.id, action, { task_id: claimed.id }),
        };
      }
      if (action === "retire_agent") {
        const retired = retireAgent(session, cleanString(args.assigned_agent_id) || agent.id, cleanString(args.content), now, idGenerator);
        if (typeof retired === "string") {
          await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
          return {
            content: retired,
            metadata: internalMetadata(session.id, agent.id, action),
          };
        }
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Agent '${retired.name}' retired.`,
          metadata: internalMetadata(session.id, agent.id, action, { retired_agent_id: retired.id }),
        };
      }
      if (action === "spawn_agent") {
        const role = cleanString(args.role);
        if (!role) {
          return { content: "Error: role is required" };
        }
        const budgetDenial = denySpawnAgentWhenBudgetExhausted(session, agent, now, idGenerator);
        if (budgetDenial) {
          await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
          return {
            content: budgetDenial,
            metadata: internalMetadata(session.id, agent.id, action, { denied_reasons: ["spawned_agent_budget_exhausted"] }),
          };
        }
        const spawned = spawnAgent(session, agent, {
          role,
          goal: cleanString(args.goal),
          responsibilities: stringList(args.responsibilities),
          tools: stringList(args.tools),
          subscriptions: stringList(args.subscriptions),
          reason: cleanString(args.content),
          name: "",
          sourceEventId: "",
          teamId: cleanString(args.team_id),
          workUnitId: cleanString(args.work_unit_id),
        }, now, idGenerator);
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Spawned agent ${spawned.id}: ${spawned.name}`,
          metadata: internalMetadata(session.id, agent.id, action, { spawned_agent_id: spawned.id }),
        };
      }
      if (action === "spawn_subteam") {
        const agentSpecs = objectList(args.agents);
        if (agentSpecs.length === 0) {
          return { content: "Error: agents are required" };
        }
        const budgetDenial = denySpawnAgentWhenBudgetExhausted(session, agent, now, idGenerator);
        if (budgetDenial) {
          await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
          return {
            content: budgetDenial,
            metadata: internalMetadata(session.id, agent.id, action, { denied_reasons: ["spawned_agent_budget_exhausted"] }),
          };
        }
        const spawned = spawnSubteam(session, agent, {
          teamId: cleanString(args.team_id) || cleanString(args.title) || "subteam",
          agents: agentSpecs,
          tasks: objectList(args.tasks),
          reason: cleanString(args.content),
        }, now, idGenerator);
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Spawned subteam ${spawned.teamId} with ${spawned.agentIds.length} agent(s).`,
          metadata: internalMetadata(session.id, agent.id, action, {
            team_id: spawned.teamId,
            agent_ids: spawned.agentIds,
            task_ids: spawned.taskIds,
          }),
        };
      }
      if (action === "update_status") {
        const status = normalizeAgentStatus(args.status);
        if (!status) {
          return { content: "Error: invalid status" };
        }
        agent.status = status;
        agent.last_active_at = now();
        session.events = [
          ...session.events,
          event(idGenerator, now, "agent.status", `${agent.name} set status to ${status}`, {
            actorId: agent.id,
            data: { agent_id: agent.id, status, source: "cowork_internal" },
          }),
        ];
        session.updated_at = now();
        await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
        return {
          content: `Status updated to ${status}`,
          metadata: internalMetadata(session.id, agent.id, action, { status }),
        };
      }
      if (action !== "complete_task") {
        return { content: `Error: unknown action '${action}'` };
      }
      const taskId = cleanString(args.task_id) || cleanString(agent.current_task_id);
      if (!taskId) {
        return { content: "Error: task_id is required" };
      }
      const task = session.tasks[taskId];
      if (!task) {
        return { content: `Error: task '${taskId}' not found` };
      }
      if (task.assigned_agent_id && task.assigned_agent_id !== agent.id) {
        return { content: `Error: task '${taskId}' is assigned to ${task.assigned_agent_id}` };
      }

      const status = normalizeTaskCompletionStatus(args.status);
      const content = cleanString(args.content) || "Completed.";
      completeTask(session, task, agent.id, status, content, now, idGenerator);
      await options.store.writeSnapshot(normalizeCoworkSession(session), traceId);
      return {
        content: `${status === "failed" ? "Failed" : "Completed"} task ${task.id}: ${task.title}`,
        metadata: internalMetadata(session.id, agent.id, action, { cowork_task_id: task.id }),
      };
    },
  };
}

function claimTask(
  session: CoworkSession,
  agent: CoworkAgent,
  requestedTaskId: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): CoworkTask | string {
  const requestedTask = requestedTaskId ? session.tasks[requestedTaskId] : undefined;
  if (requestedTask && requestedTask.assigned_agent_id && requestedTask.assigned_agent_id !== agent.id) {
    const owner = requestedTask.assigned_agent_id;
    const winner = [agent.id, owner].sort()[0] ?? agent.id;
    session.events = [
      ...session.events,
      event(idGenerator, now, "task.claim_conflict", `${agent.id} could not claim task '${requestedTask.title}' because it is owned by ${owner}`, {
        actorId: agent.id,
        data: {
          task_id: requestedTask.id,
          requested_agent_id: agent.id,
          owner_agent_id: owner,
          winner_agent_id: winner,
          source: "cowork_internal",
        },
      }),
    ];
    session.updated_at = now();
    return `Error: task '${requestedTask.id}' is already claimed by '${owner}'`;
  }

  const claimable = claimableTasksFor(session, agent.id);
  const task = requestedTaskId
    ? claimable.find((candidate) => candidate.id === requestedTaskId)
    : claimable[0];
  if (!task) {
    return `Error: no claimable task found for '${agent.id}'`;
  }

  const previousOwner = task.assigned_agent_id;
  task.assigned_agent_id = agent.id;
  task.status = "in_progress";
  task.updated_at = now();
  if (session.status === "completed") {
    session.status = "active";
  }
  session.current_focus_task = `${task.title}: ${task.description}`;
  if (agent.status === "idle" || agent.status === "done") {
    agent.status = "waiting";
  }
  agent.current_task_id = task.id;
  agent.current_task_title = task.title;
  agent.last_active_at = now();
  const eventType = previousOwner ? "task.selected" : "task.claimed";
  session.events = [
    ...session.events,
    event(idGenerator, now, eventType, `${agent.name} claimed task '${task.title}'`, {
      actorId: agent.id,
      data: {
        task_id: task.id,
        assigned_agent_id: agent.id,
        previous_owner: previousOwner,
        source: "cowork_internal",
      },
    }),
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "task",
      name: eventType === "task.claimed" ? "Task claimed" : "Task selected",
      actor_id: agent.id,
      status: task.status,
      started_at: now(),
      ended_at: now(),
      input_ref: task.id,
      output_ref: agent.id,
      summary: `${agent.name} claimed task '${task.title}'`,
      data: {
        task_id: task.id,
        assigned_agent_id: agent.id,
        previous_owner: previousOwner,
        source: "cowork_internal",
      },
    },
  ];
  session.updated_at = now();
  return task;
}

function assignTask(
  session: CoworkSession,
  sender: CoworkAgent,
  taskId: string,
  assignedAgentId: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): { task: CoworkTask; agent: CoworkAgent; message: JsonObject } | string {
  const task = session.tasks[taskId];
  if (!task) {
    return `Error: task '${taskId}' not found`;
  }
  const assignedAgent = session.agents[assignedAgentId];
  if (!assignedAgent) {
    return `Error: assigned agent '${assignedAgentId}' not found`;
  }
  task.assigned_agent_id = assignedAgent.id;
  task.updated_at = now();
  if (task.status === "failed" || task.status === "skipped") {
    task.status = "pending";
    task.error = null;
  }
  const message = sendMessage(session, sender.id, {
    recipientIds: [assignedAgent.id],
    content: `Task '${task.title}' assigned to ${assignedAgent.name}.`,
    threadId: "",
  }, now, idGenerator);
  if (assignedAgent.status === "idle" || assignedAgent.status === "done") {
    assignedAgent.status = "waiting";
  }
  session.current_focus_task = `${task.title}: ${task.description}`;
  session.events = [
    ...session.events,
    event(idGenerator, now, "task.assigned", `Task '${task.title}' assigned to ${assignedAgent.name}`, {
      actorId: sender.id,
      data: {
        task_id: task.id,
        assigned_agent_id: assignedAgent.id,
        message_id: message.id,
        source: "cowork_internal",
      },
    }),
  ];
  session.updated_at = now();
  return { task, agent: assignedAgent, message };
}

function denySpawnAgentWhenBudgetExhausted(
  session: CoworkSession,
  parent: CoworkAgent,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): string {
  const maxSpawnedAgents = numericValue(session.budget_limits.max_spawned_agents);
  if (maxSpawnedAgents <= 0 || numericValue(session.budget_usage.spawned_agents) < maxSpawnedAgents) {
    return "";
  }
  const createdAt = now();
  const guardrailId = idGenerator("dguard");
  session.delegation_guardrails[guardrailId] = {
    id: guardrailId,
    parent_agent_id: parent.id,
    max_spawned_agents: maxSpawnedAgents,
    allowed_tools: ["cowork_internal"],
    denied_reasons: ["spawned_agent_budget_exhausted"],
    created_at: createdAt,
    updated_at: createdAt,
  };
  session.stop_reason = "spawn_budget_exhausted";
  session.budget_usage = {
    ...session.budget_usage,
    stop_reason: "spawn_budget_exhausted",
  };
  session.events = [
    ...session.events,
    event(idGenerator, now, "scheduler.budget_exhausted", "Cowork agent spawn request was blocked by the spawned-agent budget", {
      actorId: "scheduler",
      data: {
        stop_reason: "spawn_budget_exhausted",
        parent_agent_id: parent.id,
        max_spawned_agents: maxSpawnedAgents,
      },
    }),
    event(idGenerator, now, "delegation.denied", "Sub-Agent delegation request was denied by guardrails", {
      actorId: parent.id,
      data: {
        guardrail_id: guardrailId,
        denied_reasons: ["spawned_agent_budget_exhausted"],
      },
    }),
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "scheduler",
      name: "Stop reason",
      actor_id: "scheduler",
      status: "blocked",
      started_at: createdAt,
      ended_at: now(),
      input_ref: "",
      output_ref: "",
      summary: "Cowork agent spawn request was blocked by the spawned-agent budget",
      data: {
        stop_reason: "spawn_budget_exhausted",
        parent_agent_id: parent.id,
        max_spawned_agents: maxSpawnedAgents,
      },
    },
  ];
  session.updated_at = now();
  return "Error: spawned-agent budget exhausted";
}

function spawnAgent(
  session: CoworkSession,
  parent: CoworkAgent,
  request: {
    role: string;
    goal: string;
    responsibilities: string[];
    tools: string[];
    subscriptions: string[];
    reason: string;
    name: string;
    sourceEventId: string;
    teamId: string;
    workUnitId: string;
  },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): CoworkAgent {
  const delegatedTaskId = idGenerator("dtask");
  const delegatedBriefId = idGenerator("dbrief");
  const guardrailId = idGenerator("dguard");
  const isolatedContextId = idGenerator("ictx");
  const agentName = request.name || request.role;
  const agentId = uniqueAgentId(session, slug(agentName) || slug(request.role) || "specialist");
  const tools = request.tools.length > 0 ? request.tools : ["cowork_internal"];
  const taskGoal = request.goal || session.goal;
  const responsibilities = request.responsibilities;
  const createdAt = now();

  session.delegation_guardrails[guardrailId] = {
    id: guardrailId,
    parent_agent_id: parent.id,
    max_spawned_agents: null,
    allowed_tools: tools,
    denied_reasons: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
  session.delegated_briefs[delegatedBriefId] = {
    id: delegatedBriefId,
    parent_agent_id: parent.id,
    task_goal: taskGoal,
    constraints: responsibilities,
    expected_output: "Compact delegated result with answer, evidence, uncertainty, artifacts, and blockers.",
    allowed_tools: tools,
    stopping_criteria: ["Return the compact result to the parent agent and stop."],
    work_unit_id: request.workUnitId,
    authorized_artifact_refs: [],
    authorized_detail_refs: [],
    redacted_reference_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
  session.delegated_tasks[delegatedTaskId] = {
    id: delegatedTaskId,
    parent_agent_id: parent.id,
    brief_id: delegatedBriefId,
    branch_id: session.current_branch_id || "default",
    architecture: session.branches[session.current_branch_id]?.architecture ?? session.workflow_mode,
    status: "active",
    guardrail_id: guardrailId,
    sub_agent_id: agentId,
    work_unit_id: request.workUnitId,
    created_at: createdAt,
    updated_at: createdAt,
  };

  const agent: CoworkAgent = {
    id: agentId,
    name: agentName || agentId,
    role: request.role || "Specialist",
    goal: taskGoal,
    responsibilities,
    tools,
    subscriptions: request.subscriptions.length > 0 ? request.subscriptions : unique([agentId, slug(request.role)].filter(Boolean)),
    communication_policy: "",
    context_policy: "Use only the delegated brief, authorized artifact/detail references, current work-unit context, and selected source summaries. Do not import the parent agent's private history.",
    status: "idle",
    private_summary: "",
    inbox: [],
    current_task_id: null,
    current_task_title: null,
    last_active_at: createdAt,
    rounds: 0,
    parent_agent_id: parent.id,
    team_id: request.teamId,
    lifetime: "temporary",
    lifecycle_status: "active",
    source_blueprint_id: "",
    source_event_id: request.sourceEventId,
    spawn_reason: request.reason,
    delegated_task_id: delegatedTaskId,
    delegated_brief_id: delegatedBriefId,
    isolated_context_id: isolatedContextId,
    sub_agent_scope: "parent",
  };
  session.agents[agent.id] = agent;
  session.isolated_sub_agent_contexts[isolatedContextId] = {
    id: isolatedContextId,
    delegated_task_id: delegatedTaskId,
    sub_agent_id: agent.id,
    parent_agent_id: parent.id,
    brief_id: delegatedBriefId,
    summary: taskGoal,
    artifact_refs: [],
    detail_refs: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
  session.budget_usage = {
    ...session.budget_usage,
    spawned_agents: numericValue(session.budget_usage.spawned_agents) + 1,
  };
  session.events = [
    ...session.events,
    event(idGenerator, now, "agent.spawned", `Spawned agent ${agent.name}`, {
      actorId: parent.id,
      data: {
        agent_id: agent.id,
        parent_agent_id: parent.id,
        source_event_id: request.sourceEventId,
        reason: request.reason,
        team_id: request.teamId,
        work_unit_id: request.workUnitId,
        lifetime: agent.lifetime,
        removed_tools_by_policy: [],
        delegated_task_id: delegatedTaskId,
        delegated_brief_id: delegatedBriefId,
        isolated_context_id: isolatedContextId,
        sub_agent_scope: agent.sub_agent_scope,
        authorized_artifact_ref_count: 0,
        authorized_detail_ref_count: 0,
        redacted_reference_count: 0,
        source: "cowork_internal",
      },
    }),
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "agent",
      name: "Agent spawned",
      actor_id: parent.id,
      status: "completed",
      started_at: createdAt,
      ended_at: now(),
      input_ref: request.role,
      output_ref: agent.id,
      summary: `Spawned agent ${agent.name}`,
      data: {
        agent_id: agent.id,
        parent_agent_id: parent.id,
        source_event_id: request.sourceEventId,
        reason: request.reason,
        team_id: request.teamId,
        work_unit_id: request.workUnitId,
        lifetime: agent.lifetime,
        removed_tools_by_policy: [],
        delegated_task_id: delegatedTaskId,
        delegated_brief_id: delegatedBriefId,
        isolated_context_id: isolatedContextId,
        authorized_artifact_ref_count: 0,
        authorized_detail_ref_count: 0,
        redacted_reference_count: 0,
        source: "cowork_internal",
      },
    },
  ];
  session.updated_at = now();
  return agent;
}

function spawnSubteam(
  session: CoworkSession,
  parent: CoworkAgent,
  request: {
    teamId: string;
    agents: JsonObject[];
    tasks: JsonObject[];
    reason: string;
  },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): { teamId: string; agentIds: string[]; taskIds: string[] } {
  const teamId = slug(request.teamId) || "subteam";
  const sourceEventId = idGenerator("evt_src");
  const agentIds: string[] = [];
  const taskIds: string[] = [];

  for (const rawAgent of request.agents) {
    const spawned = spawnAgent(session, parent, {
      role: cleanString(rawAgent.role) || "Specialist",
      goal: cleanString(rawAgent.goal) || session.goal,
      name: cleanString(rawAgent.name) || cleanString(rawAgent.id),
      responsibilities: stringList(rawAgent.responsibilities),
      tools: stringList(rawAgent.tools),
      subscriptions: stringList(rawAgent.subscriptions),
      reason: request.reason,
      sourceEventId,
      teamId,
      workUnitId: cleanString(rawAgent.work_unit_id) || cleanString(rawAgent.source_work_unit_id),
    }, now, idGenerator);
    agentIds.push(spawned.id);
  }

  for (const rawTask of request.tasks) {
    const requestedOwner = slug(cleanString(rawTask.assigned_agent_id) || cleanString(rawTask.owner));
    const assignedAgentId = requestedOwner && session.agents[requestedOwner]
      ? requestedOwner
      : agentIds[0] ?? parent.id;
    const task = addTask(session, parent, {
      title: cleanString(rawTask.title) || "Subteam task",
      description: cleanString(rawTask.description) || cleanString(rawTask.title) || session.goal,
      assignedAgentId,
      dependencies: stringList(rawTask.dependencies),
      fanoutGroupId: cleanString(rawTask.fanout_group_id) || teamId,
      mergeTaskId: cleanString(rawTask.merge_task_id),
      sourceEventId,
    }, now, idGenerator);
    taskIds.push(task.id);
  }

  if (agentIds.length > 0) {
    sendMessage(session, parent.id, {
      recipientIds: agentIds,
      content: request.reason || `Kick off subteam ${teamId}.`,
      threadId: "",
    }, now, idGenerator);
  }
  session.events = [
    ...session.events,
    event(idGenerator, now, "subteam.spawned", `Spawned subteam ${teamId}`, {
      actorId: parent.id,
      data: {
        team_id: teamId,
        agent_ids: agentIds,
        task_ids: taskIds,
        reason: request.reason,
        source_event_id: sourceEventId,
        source: "cowork_internal",
      },
    }),
  ];
  session.updated_at = now();
  return { teamId, agentIds, taskIds };
}

function retireAgent(
  session: CoworkSession,
  agentId: string,
  reason: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): CoworkAgent | string {
  const agent = session.agents[agentId];
  if (!agent) {
    return `Error: agent '${agentId}' not found`;
  }
  agent.lifecycle_status = "retired";
  agent.status = "retired";
  agent.current_task_id = null;
  agent.current_task_title = null;
  agent.last_active_at = now();

  const delegatedTaskId = cleanString(agent.delegated_task_id);
  const delegated = delegatedTaskId ? session.delegated_tasks[delegatedTaskId] : undefined;
  if (delegated && !["completed", "failed", "denied"].includes(cleanString(delegated.status))) {
    delegated.status = "retired";
    delegated.retired_at = now();
    delegated.updated_at = now();
    delegated.error = cleanString(delegated.error) || reason || "Sub-Agent retired before returning a result.";
  }

  session.events = [
    ...session.events,
    event(idGenerator, now, "agent.retired", `${agent.name} retired from scheduling`, {
      actorId: agent.id,
      data: {
        agent_id: agent.id,
        reason,
        delegated_task_id: delegatedTaskId,
        source: "cowork_internal",
      },
    }),
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "agent",
      name: "Agent retired",
      actor_id: agent.id,
      status: "completed",
      started_at: now(),
      ended_at: now(),
      input_ref: agent.id,
      output_ref: "retired",
      summary: `${agent.name} retired from scheduling`,
      data: {
        agent_id: agent.id,
        reason,
        source: "cowork_internal",
      },
    },
  ];
  session.updated_at = now();
  return agent;
}

function sendMessage(
  session: CoworkSession,
  senderId: string,
  request: { content: string; recipientIds: string[]; threadId: string },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): JsonObject {
  const recipients = validRecipients(session, request.recipientIds, senderId);
  const thread = ensureThread(session, request.threadId, "General discussion", [senderId, ...recipients], now, idGenerator);
  const messageId = idGenerator("msg");
  const message = {
    id: messageId,
    thread_id: cleanString(thread.id),
    sender_id: senderId,
    recipient_ids: recipients,
    content: request.content,
    visibility: recipients.length > 0 ? "direct" : "group",
    kind: "message",
    created_at: now(),
    read_by: [senderId],
    envelope_id: null,
  };
  session.messages[messageId] = message;
  thread.message_ids = [...stringList(thread.message_ids), messageId];
  thread.updated_at = now();
  thread.last_message_at = message.created_at;
  for (const recipientId of recipients) {
    const recipient = session.agents[recipientId];
    if (recipient && !recipient.inbox.includes(messageId)) {
      recipient.inbox = [...recipient.inbox, messageId];
      if (recipient.status === "idle" || recipient.status === "done") {
        recipient.status = "waiting";
      }
    }
  }
  session.events = [
    ...session.events,
    event(idGenerator, now, "message.sent", `${senderId} sent a message to ${recipients.join(", ") || "group"}`, {
      actorId: senderId,
      data: { message_id: messageId, thread_id: message.thread_id, recipients, source: "cowork_internal" },
    }),
  ];
  session.updated_at = now();
  return message;
}

function createThread(
  session: CoworkSession,
  senderId: string,
  request: { topic: string; participantIds: string[] },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): JsonObject {
  const threadId = idGenerator("thread");
  const participants = unique([senderId, ...request.participantIds]
    .map(cleanString)
    .filter((participant) => participant === "user" || Boolean(session.agents[participant])));
  const thread = {
    id: threadId,
    topic: request.topic || "Discussion",
    participant_ids: participants,
    message_ids: [],
    status: "open",
    created_at: now(),
    updated_at: now(),
    last_message_at: null,
  };
  session.threads[threadId] = thread;
  session.events = [
    ...session.events,
    event(idGenerator, now, "thread.created", `Thread '${thread.topic}' created`, {
      actorId: senderId,
      data: { thread_id: threadId, source: "cowork_internal" },
    }),
  ];
  session.updated_at = now();
  return thread;
}

function addTask(
  session: CoworkSession,
  sender: CoworkAgent,
  request: {
    title: string;
    description: string;
    assignedAgentId: string;
    dependencies: string[];
    fanoutGroupId: string;
    mergeTaskId: string;
    sourceEventId: string;
  },
  now: () => string,
  idGenerator: CoworkIdGenerator,
): CoworkTask {
  const assignedAgentId = request.assignedAgentId && session.agents[request.assignedAgentId]
    ? request.assignedAgentId
    : sender.id;
  const taskId = idGenerator("task");
  const task: CoworkTask = {
    id: taskId,
    title: request.title,
    description: request.description,
    assigned_agent_id: assignedAgentId,
    dependencies: request.dependencies.filter((dependency) => Boolean(session.tasks[dependency])),
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
    fanout_group_id: request.fanoutGroupId,
    merge_task_id: request.mergeTaskId,
    source_blueprint_id: "",
    source_event_id: request.sourceEventId,
    runtime_created: true,
    created_at: now(),
    updated_at: now(),
  };
  session.tasks[taskId] = task;
  session.current_focus_task = `${task.title}: ${task.description}`;
  const assignedAgent = session.agents[assignedAgentId];
  if (assignedAgent && (assignedAgent.status === "idle" || assignedAgent.status === "done")) {
    assignedAgent.status = "waiting";
  }
  session.events = [
    ...session.events,
    event(idGenerator, now, "task.created", `Task '${task.title}' suggested by ${sender.name}`, {
      actorId: sender.id,
      data: {
        task_id: task.id,
        assigned_agent_id: assignedAgentId,
        dependencies: task.dependencies,
        fanout_group_id: task.fanout_group_id,
        merge_task_id: task.merge_task_id,
        source_event_id: task.source_event_id,
        source: "cowork_internal",
      },
    }),
  ];
  session.updated_at = now();
  return task;
}

function completeTask(
  session: CoworkSession,
  task: CoworkTask,
  agentId: string,
  status: "completed" | "failed" | "skipped",
  content: string,
  now: () => string,
  idGenerator: CoworkIdGenerator,
): void {
  const resultData = parseStructuredResult(content);
  const confidence = Object.keys(resultData).length > 0 ? coerceConfidence(resultData.confidence) : null;
  task.status = status;
  task.result = content;
  task.result_data = resultData;
  task.confidence = confidence;
  task.error = status === "failed" ? content : null;
  task.updated_at = now();
  const assignedAgent = task.assigned_agent_id ? session.agents[task.assigned_agent_id] : undefined;
  if (assignedAgent) {
    assignedAgent.current_task_id = null;
    assignedAgent.current_task_title = null;
    assignedAgent.status = status === "failed" ? "failed" : "idle";
    assignedAgent.last_active_at = now();
  }
  session.current_focus_task = "";
  session.events = [
    ...session.events,
    event(idGenerator, now, `task.${status}`, `Task '${task.title}' ${status} by ${agentId}`, {
      actorId: agentId,
      data: { task_id: task.id, source: "cowork_internal" },
    }),
  ];
  session.trace_spans = [
    ...session.trace_spans,
    {
      id: idGenerator("span"),
      session_id: session.id,
      kind: "task",
      name: `Task ${status}`,
      actor_id: task.assigned_agent_id ?? agentId,
      status,
      started_at: now(),
      ended_at: now(),
      input_ref: task.description,
      output_ref: content,
      summary: `Task '${task.title}' ${status}`,
      data: {
        task_id: task.id,
        confidence,
        result_data: task.result_data,
        source: "cowork_internal",
      },
      ...(status === "failed" ? { error: content } : {}),
    },
  ];
  if (status === "completed") {
    mergeTaskArtifacts(session, resultData);
    refreshSharedMemory(session);
  }
  updateCompletionState(session, now);
  session.updated_at = now();
}

function normalizeTaskCompletionStatus(value: unknown): "completed" | "failed" | "skipped" {
  const status = cleanString(value);
  return status === "failed" || status === "skipped" ? status : "completed";
}

function updateCompletionState(session: CoworkSession, now: () => string): void {
  if (session.workflow_mode === "swarm") {
    return;
  }
  const tasks = Object.values(session.tasks);
  if (tasks.length === 0) {
    return;
  }
  const hasUnresolvedReplies = Object.values(session.mailbox).some((record) => {
    if (!isJsonObject(record)) {
      return false;
    }
    const status = cleanString(record.status);
    return record.requires_reply === true && (status === "delivered" || status === "read");
  });
  if (hasUnresolvedReplies || !tasks.every((candidate) => candidate.status === "completed" || candidate.status === "skipped")) {
    return;
  }
  refreshSharedMemory(session);
  session.status = "completed";
  for (const agent of Object.values(session.agents)) {
    if (agent.status !== "failed" && agent.status !== "blocked") {
      agent.status = "done";
    }
  }
  session.completion_decision = {
    next_action: "complete",
    reason: "All tasks are complete and there are no unresolved reply requests.",
    blocked: [],
    ready_to_finish: true,
    updated_at: now(),
  };
}

function event(
  idGenerator: CoworkIdGenerator,
  now: () => string,
  type: string,
  message: string,
  options: { actorId?: string; data?: JsonObject } = {},
): CoworkEvent {
  return {
    id: idGenerator("evt"),
    type,
    message,
    ...(options.actorId !== undefined ? { actor_id: options.actorId } : {}),
    ...(isJsonObject(options.data) ? { data: { ...options.data } } : {}),
    created_at: now(),
  };
}

function ensureThread(
  session: CoworkSession,
  threadId: string,
  topic: string,
  participants: string[],
  now: () => string,
  idGenerator: CoworkIdGenerator,
): JsonObject {
  const existing = threadId ? session.threads[threadId] : undefined;
  if (existing) {
    const currentParticipants = new Set(stringList(existing.participant_ids));
    for (const participant of participants) {
      if (participant === "user" || session.agents[participant]) {
        currentParticipants.add(participant);
      }
    }
    existing.participant_ids = [...currentParticipants];
    return existing;
  }
  const first = Object.values(session.threads)[0];
  if (first) {
    const currentParticipants = new Set(stringList(first.participant_ids));
    for (const participant of participants) {
      if (participant === "user" || session.agents[participant]) {
        currentParticipants.add(participant);
      }
    }
    first.participant_ids = [...currentParticipants];
    return first;
  }
  const id = idGenerator("thread");
  const thread = {
    id,
    topic,
    participant_ids: unique(participants.filter((participant) => participant === "user" || session.agents[participant])),
    message_ids: [],
    status: "open",
    created_at: now(),
    updated_at: now(),
    last_message_at: null,
  };
  session.threads[id] = thread;
  return thread;
}

function validRecipients(session: CoworkSession, recipients: string[], senderId: string): string[] {
  const clean = unique(recipients.map(cleanString).filter(Boolean))
    .filter((recipient) => recipient === "user" || Boolean(session.agents[recipient]))
    .filter((recipient) => recipient !== senderId);
  return clean.length > 0 ? clean : Object.keys(session.agents).filter((agentId) => agentId !== senderId);
}

function claimableTasksFor(session: CoworkSession, agentId: string): CoworkTask[] {
  const completed = new Set(Object.values(session.tasks)
    .filter((task) => task.status === "completed" || task.status === "skipped")
    .map((task) => task.id));
  return Object.values(session.tasks)
    .filter((task) => task.status === "pending")
    .filter((task) => !task.assigned_agent_id || task.assigned_agent_id === agentId)
    .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function internalMetadata(
  sessionId: string,
  agentId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cowork_session_id: sessionId,
    cowork_agent_id: agentId,
    cowork_internal_action: action,
    ...extra,
  };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeAgentStatus(value: unknown): "idle" | "working" | "waiting" | "blocked" | "done" | "failed" | null {
  const status = cleanString(value);
  return ["idle", "working", "waiting", "blocked", "done", "failed"].includes(status)
    ? status as "idle" | "working" | "waiting" | "blocked" | "done" | "failed"
    : null;
}

function parseStructuredResult(result: string): JsonObject {
  const text = result.trim();
  if (!text) {
    return {};
  }
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isJsonObject(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

function coerceConfidence(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = typeof value === "number" ? "" : cleanString(value);
  if (typeof value !== "number" && !text) {
    return null;
  }
  const confidence = typeof value === "number" ? value : Number(text);
  if (!Number.isFinite(confidence)) {
    return null;
  }
  const normalized = confidence > 1 ? confidence / 100 : confidence;
  return Math.min(Math.max(normalized, 0), 1);
}

function mergeTaskArtifacts(session: CoworkSession, resultData: JsonObject): void {
  const artifacts: string[] = [];
  for (const key of ["artifacts", "artifact_paths", "generated_files", "files", "paths"]) {
    const raw = resultData[key];
    if (Array.isArray(raw)) {
      artifacts.push(...raw.map(textValue).filter(Boolean));
    } else {
      const text = textValue(raw);
      if (text) {
        artifacts.push(text);
      }
    }
  }
  const outputDir = textValue(resultData.output_dir) || textValue(resultData.workspace_dir);
  if (outputDir) {
    session.workspace_dir = outputDir;
  }
  session.artifacts = unique([...session.artifacts, ...artifacts]).slice(-80);
}

function refreshSharedMemory(session: CoworkSession): void {
  ensureSharedMemory(session);
  const completed = Object.values(session.tasks).filter((task) => task.status === "completed").slice(-8);
  for (const task of completed) {
    const data = isJsonObject(task.result_data) ? task.result_data : {};
    const source = {
      source_task_id: task.id,
      source_task_title: task.title,
      author: task.assigned_agent_id ?? "",
      confidence: task.confidence,
      updated_at: task.updated_at,
    };
    mergeSharedMemoryValues(session, "findings", data.findings, source);
    mergeSharedMemoryValues(session, "claims", data.claims, source);
    mergeSharedMemoryValues(session, "risks", data.risks, source);
    mergeSharedMemoryValues(session, "open_questions", data.open_questions, source);
    mergeSharedMemoryValues(session, "decisions", data.decisions, source);
    const answer = textValue(data.answer);
    if (answer) {
      mergeSharedMemoryValues(session, "claims", [answer], source);
    }
    if (Object.keys(data).length === 0 && task.result) {
      mergeSharedMemoryValues(session, "findings", [`${task.title}: ${task.result.slice(0, 280)}`], source);
    }
  }
  for (const artifact of session.artifacts.slice(-20)) {
    mergeSharedMemoryValues(session, "artifacts", [artifact], { source_task_id: "", author: "", confidence: null });
  }
  session.shared_summary = buildSharedSummary(session);
}

function mergeSharedMemoryValues(
  session: CoworkSession,
  bucket: string,
  values: unknown,
  source: JsonObject,
): void {
  ensureSharedMemoryBucket(session, bucket);
  const items = Array.isArray(values) ? values : values === undefined || values === null || values === "" ? [] : [values];
  const existing = new Set(session.shared_memory[bucket].map((entry) => `${textValue(entry.text)}\0${textValue(entry.source_task_id)}`));
  for (const item of items) {
    const text = textValue(item);
    if (!text) {
      continue;
    }
    const key = `${text}\0${textValue(source.source_task_id)}`;
    if (existing.has(key)) {
      continue;
    }
    session.shared_memory[bucket].push({
      text,
      ...Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== null && value !== "")),
    });
    existing.add(key);
  }
  session.shared_memory[bucket] = session.shared_memory[bucket].slice(-80);
}

function buildSharedSummary(session: CoworkSession): string {
  const sections: string[] = [];
  const findings = [...sharedMemoryTexts(session, "findings"), ...sharedMemoryTexts(session, "claims")];
  const decisions = sharedMemoryTexts(session, "decisions");
  const risks = sharedMemoryTexts(session, "risks");
  const openQuestions = sharedMemoryTexts(session, "open_questions");
  if (findings.length > 0) {
    sections.push(`Confirmed findings:\n${findings.slice(-10).map((item) => `- ${item}`).join("\n")}`);
  }
  if (decisions.length > 0) {
    sections.push(`Decisions:\n${decisions.slice(-6).map((item) => `- ${item}`).join("\n")}`);
  }
  if (risks.length > 0) {
    sections.push(`Risks:\n${risks.slice(-6).map((item) => `- ${item}`).join("\n")}`);
  }
  if (openQuestions.length > 0) {
    sections.push(`Open questions:\n${openQuestions.slice(-6).map((item) => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n").slice(-4000);
}

function sharedMemoryTexts(session: CoworkSession, bucket: string): string[] {
  ensureSharedMemoryBucket(session, bucket);
  return session.shared_memory[bucket].map((entry) => textValue(entry.text)).filter(Boolean);
}

function ensureSharedMemory(session: CoworkSession): void {
  for (const bucket of ["findings", "claims", "risks", "open_questions", "decisions", "artifacts"]) {
    ensureSharedMemoryBucket(session, bucket);
  }
}

function ensureSharedMemoryBucket(session: CoworkSession, bucket: string): void {
  if (!Array.isArray(session.shared_memory[bucket])) {
    session.shared_memory[bucket] = [];
  }
}

function uniqueAgentId(session: CoworkSession, baseId: string): string {
  const base = baseId || "specialist";
  let candidate = base;
  let counter = 2;
  while (session.agents[candidate]) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  return candidate;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function numericValue(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(cleanString(value));
  return Number.isFinite(numeric) ? numeric : 0;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isJsonObject(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}
