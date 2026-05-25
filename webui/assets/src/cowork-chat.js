const ACTIVE_SESSION_STATUSES = new Set(["active", "running", "paused", "blocked"]);
const DONE_TASK_STATUSES = new Set(["completed", "done", "reviewed", "accepted"]);
const ACTIVE_WORK_STATUSES = new Set(["active", "running", "working", "in_progress"]);
const ATTENTION_STATUSES = new Set(["blocked", "failed", "error", "needs_revision", "expired"]);
const PENDING_REPLY_STATUSES = new Set(["delivered", "read", "pending"]);

export function createChatCoworkState() {
  return {
    sessionsByChat: new Map(),
    refreshTimers: new Map(),
    loadingKeys: new Set(),
    lastEvents: new Map(),
  };
}

export function chatCoworkKey(chatId, sessionId) {
  return `${chatId || ""}:${sessionId || ""}`;
}

export function coworkAgentActivityKey(sessionId, agentId) {
  return `${sessionId || ""}:${agentId || ""}`;
}

export function normalizeCoworkStateEvent(payload = {}) {
  if (!payload || payload.event !== "cowork_state") {
    return null;
  }
  const chatId = String(payload.chat_id || "").trim();
  const sessionId = String(payload.session_id || "").trim();
  if (!chatId || !sessionId) {
    return null;
  }
  return {
    chat_id: chatId,
    session_id: sessionId,
    change_type: String(payload.change_type || "updated"),
    agent_id: String(payload.agent_id || ""),
    task_id: String(payload.task_id || ""),
    work_unit_id: String(payload.work_unit_id || ""),
    status: String(payload.status || ""),
    updated_at: String(payload.updated_at || new Date().toISOString()),
  };
}

export function upsertChatCoworkSession(chatCowork, chatId, session) {
  if (!chatCowork || !chatId || !session?.id) {
    return [];
  }
  if (!chatCowork.sessionsByChat.has(chatId)) {
    chatCowork.sessionsByChat.set(chatId, new Map());
  }
  const sessions = chatCowork.sessionsByChat.get(chatId);
  sessions.set(session.id, {
    ...session,
    _chat_id: chatId,
    _chat_updated_at: session.updated_at || session.created_at || new Date().toISOString(),
  });
  return getChatCoworkSessions(chatCowork, chatId);
}

export function rememberCoworkStateEvent(chatCowork, event) {
  if (!chatCowork || !event?.chat_id || !event?.session_id) {
    return null;
  }
  const key = chatCoworkKey(event.chat_id, event.session_id);
  chatCowork.lastEvents.set(key, event);
  return event;
}

export function getChatCoworkSessions(chatCowork, chatId) {
  const sessions = [...(chatCowork?.sessionsByChat?.get(chatId)?.values() || [])]
    .filter((session) => Array.isArray(session.agents) && session.agents.length > 0);
  sessions.sort((left, right) => {
    const leftActive = isCoworkSessionActive(left) ? 1 : 0;
    const rightActive = isCoworkSessionActive(right) ? 1 : 0;
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }
    return String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""));
  });
  return sessions;
}

export function selectVisibleChatCoworkSessions(chatCowork, chatId) {
  const sessions = getChatCoworkSessions(chatCowork, chatId);
  if (sessions.length <= 1) {
    return sessions;
  }
  const active = sessions.filter(isCoworkSessionActive);
  return [active[0] || sessions[0]];
}

export function isCoworkSessionActive(session) {
  return ACTIVE_SESSION_STATUSES.has(String(session?.status || "").toLowerCase());
}

export function summarizeCoworkTasks(session) {
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const total = tasks.length;
  const completed = tasks.filter((task) => DONE_TASK_STATUSES.has(String(task.status || "").toLowerCase())).length;
  const failed = tasks.filter((task) => String(task.status || "").toLowerCase() === "failed").length;
  const blocked = tasks.filter((task) => String(task.status || "").toLowerCase() === "blocked").length;
  return { total, completed, failed, blocked };
}

export function coworkFinalOutput(session) {
  const decision = session?.completion_decision || {};
  const sessionFinalResult = session?.session_final_result || {};
  return String(
    session?.final_draft
      || sessionFinalResult.summary
      || decision.final_output
      || decision.final_answer
      || "",
  ).trim();
}

function pluralizeCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function summarizeCoworkAttention(session) {
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const agents = Array.isArray(session?.agents) ? session.agents : [];
  const mailbox = Array.isArray(session?.mailbox) ? session.mailbox : [];
  const workUnits = Array.isArray(session?.swarm_plan?.work_units) ? session.swarm_plan.work_units : [];
  const decision = session?.completion_decision || {};
  const decisionBlockers = [
    ...(Array.isArray(decision.blocked) ? decision.blocked : []),
    ...(Array.isArray(decision.review_blockers) ? decision.review_blockers : []),
    ...(Array.isArray(decision.fanout_blockers) ? decision.fanout_blockers : []),
    ...(Array.isArray(decision.disagreements) ? decision.disagreements : []),
  ];
  const taskIssues = tasks.filter((task) => ATTENTION_STATUSES.has(String(task.status || "").toLowerCase()));
  const unitIssues = workUnits.filter((unit) => ATTENTION_STATUSES.has(String(unit.status || "").toLowerCase()));
  const agentIssues = agents.filter((agent) => ATTENTION_STATUSES.has(String(agent.status || agent.lifecycle_status || "").toLowerCase()));
  const pendingReplies = mailbox.filter((record) => {
    const status = String(record.status || "").toLowerCase();
    return Boolean(record.requires_reply) && (!status || PENDING_REPLY_STATUSES.has(status));
  });
  const total = decisionBlockers.length + taskIssues.length + unitIssues.length + agentIssues.length + pendingReplies.length;
  let label = "";
  if (decisionBlockers.length) {
    label = `${decisionBlockers.length} blocker${decisionBlockers.length === 1 ? "" : "s"}`;
  } else if (pendingReplies.length) {
    label = `${pluralizeCount(pendingReplies.length, "reply", "replies")} needed`;
  } else if (taskIssues.length || unitIssues.length) {
    const count = taskIssues.length + unitIssues.length;
    label = `${count} work item${count === 1 ? "" : "s"} need attention`;
  } else if (agentIssues.length) {
    label = `${agentIssues.length} agent${agentIssues.length === 1 ? "" : "s"} need attention`;
  } else {
    label = coworkFinalOutput(session) ? "Final output ready" : "No attention needed";
  }
  return {
    total,
    blockers: decisionBlockers.length,
    pending_replies: pendingReplies.length,
    task_issues: taskIssues.length,
    work_unit_issues: unitIssues.length,
    agent_issues: agentIssues.length,
    tone: total ? "attention" : coworkFinalOutput(session) ? "complete" : "normal",
    label,
  };
}

export function deriveCoworkRunSummary(session) {
  const agents = Array.isArray(session?.agents) ? session.agents : [];
  const taskProgress = summarizeCoworkTasks(session);
  const finalOutput = coworkFinalOutput(session);
  const attention = summarizeCoworkAttention(session);
  const activeAgents = isCoworkSessionActive(session)
    ? agents.filter((agent) => ACTIVE_WORK_STATUSES.has(String(agent.status || agent.lifecycle_status || "").toLowerCase()))
    : [];
  return {
    id: String(session?.id || ""),
    title: String(session?.title || session?.goal || session?.id || "Cowork session"),
    status: String(session?.status || "active"),
    workflow: String(session?.architecture || session?.workflow_mode || ""),
    agentCount: agents.length,
    activeAgentCount: activeAgents.length,
    taskProgress,
    finalOutput,
    attention,
  };
}

export function agentDisplayLabel(agent, index = 0) {
  const name = String(agent?.name || "").trim();
  if (name) {
    return name;
  }
  const role = String(agent?.role || "").trim();
  return role ? `${role} ${index + 1}` : `Agent ${index + 1}`;
}

export function agentCurrentTask(session, agent) {
  if (agent?.current_task_title) {
    return agent.current_task_title;
  }
  const taskId = agent?.current_task_id;
  if (!taskId) {
    return agent?.goal || "";
  }
  const task = (session?.tasks || []).find((item) => item.id === taskId);
  return task?.title || agent?.goal || "";
}

export function agentRecentActivity(session, agent, event = null) {
  if (event?.agent_id && event.agent_id === agent?.id) {
    return event.change_type || event.status || "updated";
  }
  const steps = Array.isArray(session?.agent_steps) ? session.agent_steps : [];
  const latestStep = [...steps].reverse().find((step) => step.agent_id === agent?.id);
  if (latestStep) {
    return latestStep.action_kind || latestStep.status || latestStep.updated_at || "step";
  }
  return agent?.last_active_at ? `active ${agent.last_active_at}` : "waiting";
}

export function deriveCoworkAgentAttention(session, agent) {
  const status = String(agent?.status || agent?.lifecycle_status || "").toLowerCase();
  if (ATTENTION_STATUSES.has(status)) {
    return { state: status, label: status.replaceAll("_", " "), tone: "attention" };
  }
  if (Number(agent?.pending_reply_count || 0) > 0) {
    return { state: "reply_needed", label: "reply needed", tone: "attention" };
  }
  const mailbox = Array.isArray(session?.mailbox) ? session.mailbox : [];
  const waitingReply = mailbox.find((record) => {
    const recipients = Array.isArray(record.recipient_ids) ? record.recipient_ids : [];
    const recordStatus = String(record.status || "").toLowerCase();
    return recipients.includes(agent?.id) && record.requires_reply && (!recordStatus || PENDING_REPLY_STATUSES.has(recordStatus));
  });
  if (waitingReply) {
    return { state: "reply_needed", label: "reply needed", tone: "attention" };
  }
  const task = Array.isArray(session?.tasks)
    ? session.tasks.find((item) => item.id && item.id === agent?.current_task_id)
    : null;
  const taskStatus = String(task?.status || "").toLowerCase();
  if (ATTENTION_STATUSES.has(taskStatus)) {
    return { state: taskStatus, label: taskStatus.replaceAll("_", " "), tone: "attention" };
  }
  if (["waiting", "paused", "idle"].includes(status)) {
    return { state: status || "waiting", label: status || "waiting", tone: "waiting" };
  }
  return { state: "normal", label: "", tone: "normal" };
}

export function deriveCoworkAgentSummary(session, agent, index = 0, event = null) {
  return {
    id: String(agent?.id || ""),
    label: agentDisplayLabel(agent, index),
    roleOrTask: agentCurrentTask(session, agent) || agent?.role || "Waiting for work",
    status: String(agent?.status || agent?.lifecycle_status || "idle"),
    latestActivity: agentRecentActivity(session, agent, event),
    attention: deriveCoworkAgentAttention(session, agent),
  };
}

export function normalizeCoworkAgentActivityPayload(payload = {}, selection = {}) {
  const activity = payload?.activity && typeof payload.activity === "object" ? payload.activity : payload;
  const sessionId = String(activity.session_id || selection.sessionId || selection.session_id || "");
  const agentId = String(activity.agent_id || activity.agent?.id || selection.agentId || selection.agent_id || "");
  return {
    ...activity,
    available: activity.available !== false,
    session_id: sessionId,
    agent_id: agentId,
    agent: activity.agent || { id: agentId },
    recent_steps: Array.isArray(activity.recent_steps) ? activity.recent_steps : [],
    linked_tasks: Array.isArray(activity.linked_tasks) ? activity.linked_tasks : [],
    linked_messages: Array.isArray(activity.linked_messages) ? activity.linked_messages : [],
    mailbox_records: Array.isArray(activity.mailbox_records) ? activity.mailbox_records : [],
    tool_observations: Array.isArray(activity.tool_observations) ? activity.tool_observations : [],
    browser_observations: Array.isArray(activity.browser_observations) ? activity.browser_observations : [],
    artifacts: Array.isArray(activity.artifacts) ? activity.artifacts : [],
    counts: activity.counts || {},
  };
}

export function observationDetailState(observation = {}) {
  if (observation.redacted) {
    return "redacted";
  }
  if (observation.sensitive) {
    return "sensitive";
  }
  if (!observation.detail_ref) {
    return "unavailable";
  }
  return "available";
}
