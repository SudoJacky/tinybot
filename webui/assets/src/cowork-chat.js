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
    liveStreams: new Map(),
    streamRenderTimers: new Map(),
  };
}

export function chatCoworkKey(chatId, sessionId) {
  return `${chatId || ""}:${sessionId || ""}`;
}

export function coworkAgentActivityKey(sessionId, agentId) {
  return `${sessionId || ""}:${agentId || ""}`;
}

export function coworkLiveStreamKey(chatId, sessionId, agentId, stepId) {
  return `${chatId || ""}:${sessionId || ""}:${agentId || ""}:${stepId || ""}`;
}

export function shouldRefreshCoworkAgentInspectorForStream(selection, chatId) {
  return Boolean(selection?.chatId && chatId && selection.chatId === chatId);
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

export function normalizeCoworkStreamEvent(payload = {}) {
  if (!payload || payload.event !== "cowork_stream") {
    return null;
  }
  const chatId = String(payload.chat_id || "").trim();
  const sessionId = String(payload.session_id || "").trim();
  const agentId = String(payload.agent_id || "").trim();
  const stepId = String(payload.step_id || "").trim();
  if (!chatId || !sessionId || !agentId || !stepId) {
    return null;
  }
  const phase = String(payload.phase || "delta").trim() || "delta";
  const sequence = Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : 0;
  return {
    chat_id: chatId,
    session_id: sessionId,
    agent_id: agentId,
    step_id: stepId,
    phase,
    status: String(payload.status || ""),
    sequence,
    timestamp: String(payload.timestamp || new Date().toISOString()),
    text: String(payload.text || ""),
    completed: Boolean(payload.completed || phase === "complete"),
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
  reconcileCoworkLiveStreams(chatCowork, chatId, session);
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

export function rememberCoworkStreamEvent(chatCowork, event) {
  if (!chatCowork || !event?.chat_id || !event?.session_id || !event?.agent_id || !event?.step_id) {
    return null;
  }
  if (!chatCowork.liveStreams) {
    chatCowork.liveStreams = new Map();
  }
  const key = coworkLiveStreamKey(event.chat_id, event.session_id, event.agent_id, event.step_id);
  const existing = chatCowork.liveStreams.get(key) || {
    chat_id: event.chat_id,
    session_id: event.session_id,
    agent_id: event.agent_id,
    step_id: event.step_id,
    text: "",
    status: "",
    phase: "",
    sequence: -1,
    timestamp: "",
    completed: false,
  };
  if (event.sequence <= Number(existing.sequence || 0)) {
    return existing;
  }
  const next = {
    ...existing,
    phase: event.phase,
    status: event.status || existing.status,
    sequence: event.sequence,
    timestamp: event.timestamp || existing.timestamp,
    text: event.phase === "delta" ? `${existing.text || ""}${event.text || ""}` : existing.text || "",
    completed: Boolean(existing.completed || event.completed || event.phase === "complete" || event.phase === "interrupted"),
  };
  chatCowork.liveStreams.set(key, next);
  return next;
}

export function getCoworkLiveStreamsForAgent(chatCowork, chatId, sessionId, agentId) {
  if (!chatCowork?.liveStreams || !chatId || !sessionId || !agentId) {
    return [];
  }
  return [...chatCowork.liveStreams.values()]
    .filter((stream) => (
      stream.chat_id === chatId
      && stream.session_id === sessionId
      && stream.agent_id === agentId
      && String(stream.text || "").trim()
    ))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

export function reconcileCoworkLiveStreams(chatCowork, chatId, session) {
  if (!chatCowork?.liveStreams || !chatId || !session?.id) {
    return;
  }
  const completedStepIds = new Set(
    (Array.isArray(session.agent_steps) ? session.agent_steps : [])
      .filter((step) => (
        ["completed", "failed", "blocked", "stopped"].includes(String(step.status || "").toLowerCase())
        || String(step.output_summary || "").trim()
      ))
      .map((step) => String(step.id || "").trim())
      .filter(Boolean),
  );
  for (const [key, stream] of chatCowork.liveStreams.entries()) {
    if (stream.chat_id !== chatId || stream.session_id !== session.id) {
      continue;
    }
    if (completedStepIds.has(stream.step_id)) {
      chatCowork.liveStreams.delete(key);
    }
  }
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

export function deriveCoworkAgentTasks(activity = {}) {
  const tasks = [];
  const seen = new Set();
  const addTask = (task) => {
    const id = String(task?.id || "").trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    tasks.push({
      id,
      title: String(task?.title || id),
      status: String(task?.status || "pending"),
      description: String(task?.description || ""),
      updatedAt: String(task?.updated_at || task?.created_at || ""),
    });
  };
  addTask(activity?.current_task);
  for (const task of activity?.linked_tasks || []) {
    addTask(task);
  }
  return tasks;
}

function threadTimestampValue(value) {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function completedAgentStepIds(activity = {}, extraStepIds = null) {
  const ids = new Set(extraStepIds ? [...extraStepIds].map((item) => String(item || "").trim()).filter(Boolean) : []);
  for (const step of activity?.recent_steps || []) {
    const status = String(step?.status || "").toLowerCase();
    if (
      ["completed", "failed", "blocked", "stopped"].includes(status)
      || String(step?.output_summary || "").trim()
    ) {
      const id = String(step?.id || "").trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function normalizeLiveStreamEntries(liveStreams) {
  if (!liveStreams) {
    return [];
  }
  if (liveStreams instanceof Map) {
    return [...liveStreams.values()];
  }
  return Array.isArray(liveStreams) ? liveStreams : [];
}

export function deriveCoworkAgentThread(activity = {}, options = {}) {
  const agentId = String(options.agentId || activity?.agent_id || activity?.agent?.id || "").trim();
  const sessionId = String(options.sessionId || activity?.session_id || "").trim();
  const chatId = String(options.chatId || "").trim();
  const agentLabel = agentDisplayLabel(activity?.agent || { id: agentId }, 0);
  const items = [];

  for (const record of activity?.mailbox_records || []) {
    const sender = String(record?.sender_id || "").trim();
    const recipients = Array.isArray(record?.recipient_ids)
      ? record.recipient_ids.map((item) => String(item).trim()).filter(Boolean)
      : [];
    let direction = "neutral";
    let align = "neutral";
    if (sender && sender === agentId) {
      direction = "outgoing";
      align = "left";
    } else if (agentId && recipients.includes(agentId)) {
      direction = "incoming";
      align = "right";
    }
    const timestamp = String(record?.updated_at || record?.created_at || "");
    const id = String(record?.id || `${sender || "unknown"}:${timestamp}`);
    items.push({
      id: String(record?.id || `${sender}:${record?.created_at || record?.updated_at || ""}`),
      source: "mailbox",
      direction,
      align,
      senderLabel: sender || "unknown",
      recipientLabel: recipients.join(", ") || "none",
      route: `${sender || "unknown"} -> ${recipients.join(", ") || "none"}`,
      body: String(record?.content || ""),
      kind: String(record?.kind || "message"),
      status: String(record?.status || ""),
      requiresReply: Boolean(record?.requires_reply),
      timestamp,
      streaming: false,
      completed: true,
      sortTime: threadTimestampValue(timestamp),
      sortSequence: 0,
      sortId: id,
    });
  }

  const suppressedStepIds = completedAgentStepIds(activity, options.completedStepIds);
  for (const stream of normalizeLiveStreamEntries(options.liveStreams)) {
    if (!stream || String(stream.text || "").trim() === "") {
      continue;
    }
    if (chatId && stream.chat_id !== chatId) {
      continue;
    }
    if (sessionId && stream.session_id !== sessionId) {
      continue;
    }
    if (agentId && stream.agent_id !== agentId) {
      continue;
    }
    const stepId = String(stream.step_id || "").trim();
    if (stepId && suppressedStepIds.has(stepId)) {
      continue;
    }
    const timestamp = String(stream.timestamp || "");
    const completed = Boolean(stream.completed);
    const status = String(stream.status || (completed ? "completed" : "running"));
    const id = `live:${coworkLiveStreamKey(stream.chat_id, stream.session_id, stream.agent_id, stepId)}`;
    items.push({
      id,
      source: "live_stream",
      direction: "live_outgoing",
      align: "left",
      senderLabel: agentLabel || agentId || "Agent",
      recipientLabel: "live output",
      route: `${agentLabel || agentId || "Agent"} -> live output`,
      body: String(stream.text || ""),
      kind: "live output",
      status,
      requiresReply: false,
      timestamp,
      streaming: !completed,
      completed,
      phase: String(stream.phase || ""),
      stepId,
      sortTime: threadTimestampValue(timestamp),
      sortSequence: Number(stream.sequence || 0),
      sortId: id,
    });
  }

  items.sort((left, right) => (
    left.sortTime - right.sortTime
    || Number(left.sortSequence || 0) - Number(right.sortSequence || 0)
    || String(left.sortId || left.id).localeCompare(String(right.sortId || right.id))
  ));
  return items.map(({ sortTime, sortSequence, sortId, ...item }) => item);
}

export function deriveCoworkAgentTimeline(activity = {}) {
  return deriveCoworkAgentThread(activity);
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
