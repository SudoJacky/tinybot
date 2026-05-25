const ACTIVE_SESSION_STATUSES = new Set(["active", "running", "paused", "blocked"]);
const DONE_TASK_STATUSES = new Set(["completed", "done", "reviewed", "accepted"]);

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
