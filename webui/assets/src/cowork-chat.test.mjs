import assert from "node:assert/strict";

import {
  agentCurrentTask,
  agentDisplayLabel,
  agentRecentActivity,
  chatCoworkKey,
  coworkAgentActivityKey,
  coworkFinalOutput,
  createChatCoworkState,
  deriveCoworkAgentTasks,
  deriveCoworkAgentThread,
  deriveCoworkAgentTimeline,
  deriveCoworkAgentAttention,
  deriveCoworkAgentSummary,
  deriveCoworkRunSummary,
  getChatCoworkSessions,
  getCoworkLiveStreamsForAgent,
  normalizeCoworkStateEvent,
  normalizeCoworkStreamEvent,
  normalizeCoworkAgentActivityPayload,
  observationDetailState,
  reconcileCoworkLiveStreams,
  rememberCoworkStreamEvent,
  rememberCoworkStateEvent,
  selectVisibleChatCoworkSessions,
  shouldRefreshCoworkAgentInspectorForStream,
  summarizeCoworkAttention,
  summarizeCoworkTasks,
  upsertChatCoworkSession,
} from "./cowork-chat.js";

const chatCowork = createChatCoworkState();

assert.equal(chatCoworkKey("chat-1", "cw-1"), "chat-1:cw-1");
assert.equal(coworkAgentActivityKey("cw-1", "researcher"), "cw-1:researcher");
assert.equal(shouldRefreshCoworkAgentInspectorForStream({ chatId: "chat-1" }, "chat-1"), true);
assert.equal(shouldRefreshCoworkAgentInspectorForStream({ chatId: "chat-1" }, "chat-2"), false);
assert.equal(shouldRefreshCoworkAgentInspectorForStream(null, "chat-1"), false);
assert.equal(normalizeCoworkStateEvent({ event: "cowork_state", chat_id: "chat-1" }), null);
assert.equal(normalizeCoworkStreamEvent({ event: "cowork_stream", chat_id: "chat-1" }), null);
assert.deepEqual(
  normalizeCoworkStateEvent({
    event: "cowork_state",
    chat_id: "chat-1",
    session_id: "cw-1",
    change_type: "agent_step_completed",
    agent_id: "researcher",
    status: "active",
    updated_at: "2026-05-25T00:00:00Z",
  }),
  {
    chat_id: "chat-1",
    session_id: "cw-1",
    change_type: "agent_step_completed",
    agent_id: "researcher",
    task_id: "",
    work_unit_id: "",
    status: "active",
    updated_at: "2026-05-25T00:00:00Z",
  },
);
assert.deepEqual(
  normalizeCoworkStreamEvent({
    event: "cowork_stream",
    chat_id: "chat-1",
    session_id: "cw-1",
    agent_id: "researcher",
    step_id: "step-1",
    phase: "delta",
    status: "running",
    sequence: 1,
    timestamp: "2026-05-25T00:00:01Z",
    text: "Hello",
  }),
  {
    chat_id: "chat-1",
    session_id: "cw-1",
    agent_id: "researcher",
    step_id: "step-1",
    phase: "delta",
    status: "running",
    sequence: 1,
    timestamp: "2026-05-25T00:00:01Z",
    text: "Hello",
    completed: false,
  },
);
assert.deepEqual(
  normalizeCoworkStreamEvent({
    event: "cowork_stream",
    chat_id: "chat-1",
    session_id: "cw-1",
    agent_id: "researcher",
    step_id: "step-2",
    phase: "interrupted",
    status: "interrupted",
    sequence: 4,
    timestamp: "2026-05-25T00:00:04Z",
    completed: true,
  }),
  {
    chat_id: "chat-1",
    session_id: "cw-1",
    agent_id: "researcher",
    step_id: "step-2",
    phase: "interrupted",
    status: "interrupted",
    sequence: 4,
    timestamp: "2026-05-25T00:00:04Z",
    text: "",
    completed: true,
  },
);

const firstSession = {
  id: "cw-1",
  title: "Research plan",
  status: "active",
  architecture: "swarm",
  created_at: "2026-05-25T00:00:00Z",
  updated_at: "2026-05-25T00:01:00Z",
  agents: [
    { id: "researcher", name: "Researcher", role: "research", status: "working", current_task_id: "task-1" },
  ],
  tasks: [
    { id: "task-1", title: "Collect sources", status: "in_progress" },
    { id: "task-2", title: "Write synthesis", status: "completed" },
  ],
};

assert.equal(upsertChatCoworkSession(chatCowork, "chat-1", { id: "empty", agents: [] }).length, 0);
upsertChatCoworkSession(chatCowork, "chat-1", firstSession);
assert.equal(getChatCoworkSessions(chatCowork, "chat-1").length, 1);
assert.equal(getChatCoworkSessions(chatCowork, "chat-2").length, 0);
assert.deepEqual(summarizeCoworkTasks(firstSession), { total: 2, completed: 1, failed: 0, blocked: 0 });
assert.equal(agentDisplayLabel(firstSession.agents[0], 0), "Researcher");
assert.equal(agentDisplayLabel({ role: "critic" }, 1), "critic 2");
assert.equal(agentCurrentTask(firstSession, firstSession.agents[0]), "Collect sources");
assert.equal(coworkFinalOutput({ completion_decision: { reason: "2 task(s) still need progress." } }), "");
assert.equal(
  coworkFinalOutput({ session_final_result: { summary: "Selected final result." } }),
  "Selected final result.",
);
assert.deepEqual(summarizeCoworkAttention(firstSession), {
  total: 0,
  blockers: 0,
  pending_replies: 0,
  task_issues: 0,
  work_unit_issues: 0,
  agent_issues: 0,
  tone: "normal",
  label: "No attention needed",
});

const event = normalizeCoworkStateEvent({
  event: "cowork_state",
  chat_id: "chat-1",
  session_id: "cw-1",
  change_type: "task_progress",
  agent_id: "researcher",
});
rememberCoworkStateEvent(chatCowork, event);
assert.equal(agentRecentActivity(firstSession, firstSession.agents[0], event), "task_progress");
assert.deepEqual(deriveCoworkAgentSummary(firstSession, firstSession.agents[0], 0, event), {
  id: "researcher",
  label: "Researcher",
  roleOrTask: "Collect sources",
  status: "working",
  latestActivity: "task_progress",
  attention: { state: "normal", label: "", tone: "normal" },
});

rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-1",
  phase: "delta",
  status: "running",
  sequence: 1,
  text: "Draft ",
}));
rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "writer",
  step_id: "step-2",
  phase: "delta",
  status: "running",
  sequence: 1,
  text: "Other agent",
}));
rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-stale",
  phase: "delta",
  status: "running",
  sequence: 1,
  text: "Stale draft",
}));
rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-1",
  phase: "delta",
  status: "running",
  sequence: 2,
  text: "answer",
}));
rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-1",
  phase: "delta",
  status: "running",
  sequence: 2,
  text: " duplicate",
}));
assert.deepEqual(getCoworkLiveStreamsForAgent(chatCowork, "chat-1", "cw-1", "researcher").map((stream) => stream.text).sort(), ["Draft answer", "Stale draft"]);
assert.deepEqual(getCoworkLiveStreamsForAgent(chatCowork, "chat-1", "cw-1", "writer").map((stream) => stream.text), ["Other agent"]);
rememberCoworkStreamEvent(chatCowork, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-1",
  phase: "complete",
  status: "completed",
  sequence: 3,
  completed: true,
}));
assert.equal(getCoworkLiveStreamsForAgent(chatCowork, "chat-1", "cw-1", "researcher").find((stream) => stream.step_id === "step-1").completed, true);
reconcileCoworkLiveStreams(chatCowork, "chat-1", {
  ...firstSession,
  agent_steps: [
    { id: "step-1", agent_id: "researcher", status: "completed", output_summary: "Draft answer" },
    { id: "step-stale", agent_id: "researcher", status: "completed", output_summary: "Stale draft" },
  ],
});
assert.deepEqual(getCoworkLiveStreamsForAgent(chatCowork, "chat-1", "cw-1", "researcher"), []);
assert.deepEqual(getCoworkLiveStreamsForAgent(chatCowork, "chat-1", "cw-1", "writer").map((stream) => stream.text), ["Other agent"]);

const blockedSession = {
  ...firstSession,
  status: "blocked",
  agents: [
    { id: "researcher", name: "Researcher", role: "research", status: "blocked", current_task_id: "task-1" },
    { id: "writer", role: "writer", status: "waiting", pending_reply_count: 1 },
  ],
  tasks: [
    { id: "task-1", title: "Collect sources", status: "blocked" },
    { id: "task-2", title: "Write synthesis", status: "completed" },
  ],
  mailbox: [
    { id: "mail-1", recipient_ids: ["writer"], requires_reply: true, status: "delivered" },
  ],
  completion_decision: {
    blocked: [{ id: "mail-1", reason: "Need direction" }],
  },
};
assert.deepEqual(summarizeCoworkAttention(blockedSession), {
  total: 4,
  blockers: 1,
  pending_replies: 1,
  task_issues: 1,
  work_unit_issues: 0,
  agent_issues: 1,
  tone: "attention",
  label: "1 blocker",
});
assert.deepEqual(deriveCoworkAgentAttention(blockedSession, blockedSession.agents[0]), {
  state: "blocked",
  label: "blocked",
  tone: "attention",
});
assert.deepEqual(deriveCoworkAgentAttention(blockedSession, blockedSession.agents[1]), {
  state: "reply_needed",
  label: "reply needed",
  tone: "attention",
});
assert.equal(summarizeCoworkAttention({
  ...blockedSession,
  completion_decision: {},
  mailbox: [
    { id: "mail-1", recipient_ids: ["writer"], requires_reply: true, status: "delivered" },
    { id: "mail-2", recipient_ids: ["writer"], requires_reply: true, status: "read" },
  ],
  tasks: blockedSession.tasks.map((task) => ({ ...task, status: "completed" })),
  agents: blockedSession.agents.map((agent) => ({ ...agent, status: "working", pending_reply_count: 0 })),
}).label, "2 replies needed");

upsertChatCoworkSession(chatCowork, "chat-1", {
  id: "cw-2",
  title: "Later session",
  status: "completed",
  created_at: "2026-05-25T00:05:00Z",
  updated_at: "2026-05-25T00:08:00Z",
  agents: [{ id: "writer", role: "writer", status: "done" }],
  tasks: [{ id: "task-3", title: "Draft", status: "done" }],
});
assert.equal(getChatCoworkSessions(chatCowork, "chat-1").map((session) => session.id).join(","), "cw-1,cw-2");
assert.equal(selectVisibleChatCoworkSessions(chatCowork, "chat-1").map((session) => session.id).join(","), "cw-1");

upsertChatCoworkSession(chatCowork, "chat-1", {
  ...firstSession,
  status: "completed",
  updated_at: "2026-05-25T00:10:00Z",
  final_draft: "Complete.",
  tasks: firstSession.tasks.map((task) => ({ ...task, status: "completed" })),
});
assert.equal(selectVisibleChatCoworkSessions(chatCowork, "chat-1")[0].id, "cw-1");
assert.deepEqual(summarizeCoworkTasks(selectVisibleChatCoworkSessions(chatCowork, "chat-1")[0]), {
  total: 2,
  completed: 2,
  failed: 0,
  blocked: 0,
});
assert.deepEqual(deriveCoworkRunSummary(selectVisibleChatCoworkSessions(chatCowork, "chat-1")[0]), {
  id: "cw-1",
  title: "Research plan",
  status: "completed",
  workflow: "swarm",
  agentCount: 1,
  activeAgentCount: 0,
  taskProgress: {
    total: 2,
    completed: 2,
    failed: 0,
    blocked: 0,
  },
  finalOutput: "Complete.",
  attention: {
    total: 0,
    blockers: 0,
    pending_replies: 0,
    task_issues: 0,
    work_unit_issues: 0,
    agent_issues: 0,
    tone: "complete",
    label: "Final output ready",
  },
});

const unavailableActivity = normalizeCoworkAgentActivityPayload(
  { activity: { available: false, session_id: "cw-1", agent_id: "missing", error: "agent not found" } },
  {},
);
assert.equal(unavailableActivity.available, false);
assert.equal(unavailableActivity.agent_id, "missing");
assert.deepEqual(unavailableActivity.recent_steps, []);

const redactedActivity = normalizeCoworkAgentActivityPayload(
  {
    activity: {
      session_id: "cw-1",
      agent: { id: "researcher", name: "Researcher" },
      tool_observations: [
        { id: "obs-1", tool_name: "browser", redacted: true, detail_ref: "detail-1" },
        { id: "obs-2", tool_name: "shell", detail_ref: "detail-2" },
      ],
    },
  },
  {},
);
assert.equal(redactedActivity.available, true);
assert.equal(observationDetailState(redactedActivity.tool_observations[0]), "redacted");
assert.equal(observationDetailState(redactedActivity.tool_observations[1]), "available");

const inspectorActivity = normalizeCoworkAgentActivityPayload(
  {
    activity: {
      session_id: "cw-1",
      agent: { id: "researcher", name: "Researcher" },
      current_task: { id: "task-1", title: "Research sources", status: "in_progress", description: "Find reliable sources" },
      linked_tasks: [
        { id: "task-1", title: "Research sources", status: "in_progress", result: "do not duplicate" },
        { id: "task-2", title: "Share findings", status: "completed", result: "hidden result" },
      ],
      recent_steps: [{ id: "step-1", output_summary: "hidden step output" }],
      tool_observations: [{ id: "tool-1", result_summary: "hidden tool output" }],
      browser_observations: [{ id: "browser-1", result_summary: "hidden browser output" }],
      artifacts: [{ id: "artifact-1", value: "hidden artifact" }],
      mailbox_records: [
        {
          id: "mail-1",
          sender_id: "coordinator",
          recipient_ids: ["researcher"],
          content: "Please collect sources.",
          kind: "message",
          status: "read",
          requires_reply: true,
          updated_at: "2026-05-25T01:00:00Z",
        },
        {
          id: "mail-2",
          sender_id: "researcher",
          recipient_ids: ["coordinator"],
          content: "I found three sources.",
          kind: "message",
          status: "delivered",
          requires_reply: false,
          created_at: "2026-05-25T01:05:00Z",
        },
      ],
    },
  },
  {},
);
assert.deepEqual(deriveCoworkAgentTasks(inspectorActivity).map((task) => [task.id, task.title, task.status]), [
  ["task-1", "Research sources", "in_progress"],
  ["task-2", "Share findings", "completed"],
]);
assert.deepEqual(deriveCoworkAgentTimeline(inspectorActivity).map((item) => ({
  id: item.id,
  direction: item.direction,
  route: item.route,
  body: item.body,
  status: item.status,
  requiresReply: item.requiresReply,
})), [
  {
    id: "mail-1",
    direction: "incoming",
    route: "coordinator -> researcher",
    body: "Please collect sources.",
    status: "read",
    requiresReply: true,
  },
  {
    id: "mail-2",
    direction: "outgoing",
    route: "researcher -> coordinator",
    body: "I found three sources.",
    status: "delivered",
    requiresReply: false,
  },
]);

const threadState = createChatCoworkState();
rememberCoworkStreamEvent(threadState, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-live",
  phase: "delta",
  status: "running",
  sequence: 2,
  timestamp: "2026-05-25T01:04:00Z",
  text: "Streaming public note",
}));
rememberCoworkStreamEvent(threadState, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-2",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-other-chat",
  phase: "delta",
  status: "running",
  sequence: 3,
  timestamp: "2026-05-25T01:04:30Z",
  text: "Wrong chat",
}));
rememberCoworkStreamEvent(threadState, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "writer",
  step_id: "step-other-agent",
  phase: "delta",
  status: "running",
  sequence: 4,
  timestamp: "2026-05-25T01:04:30Z",
  text: "Wrong agent",
}));
rememberCoworkStreamEvent(threadState, normalizeCoworkStreamEvent({
  event: "cowork_stream",
  chat_id: "chat-1",
  session_id: "cw-1",
  agent_id: "researcher",
  step_id: "step-stale",
  phase: "complete",
  status: "completed",
  sequence: 5,
  timestamp: "2026-05-25T01:06:00Z",
  completed: true,
}));
const directionalThread = deriveCoworkAgentThread(inspectorActivity, {
  chatId: "chat-1",
  sessionId: "cw-1",
  agentId: "researcher",
  liveStreams: threadState.liveStreams,
});
assert.deepEqual(directionalThread.map((item) => ({
  id: item.id,
  source: item.source,
  direction: item.direction,
  align: item.align,
  senderLabel: item.senderLabel,
  recipientLabel: item.recipientLabel,
  body: item.body,
  streaming: item.streaming,
  completed: item.completed,
})), [
  {
    id: "mail-1",
    source: "mailbox",
    direction: "incoming",
    align: "right",
    senderLabel: "coordinator",
    recipientLabel: "researcher",
    body: "Please collect sources.",
    streaming: false,
    completed: true,
  },
  {
    id: "live:chat-1:cw-1:researcher:step-live",
    source: "live_stream",
    direction: "live_outgoing",
    align: "left",
    senderLabel: "Researcher",
    recipientLabel: "live output",
    body: "Streaming public note",
    streaming: true,
    completed: false,
  },
  {
    id: "mail-2",
    source: "mailbox",
    direction: "outgoing",
    align: "left",
    senderLabel: "researcher",
    recipientLabel: "coordinator",
    body: "I found three sources.",
    streaming: false,
    completed: true,
  },
]);

const ambiguousThread = deriveCoworkAgentThread({
  session_id: "cw-1",
  agent: { id: "researcher" },
  mailbox_records: [
    {
      id: "mail-ambiguous",
      sender_id: "",
      recipient_ids: [],
      content: "Keep this visible.",
      status: "pending",
      updated_at: "2026-05-25T01:00:00Z",
    },
  ],
});
assert.deepEqual(ambiguousThread.map((item) => ({
  id: item.id,
  direction: item.direction,
  align: item.align,
  route: item.route,
  body: item.body,
  status: item.status,
})), [
  {
    id: "mail-ambiguous",
    direction: "neutral",
    align: "neutral",
    route: "unknown -> none",
    body: "Keep this visible.",
    status: "pending",
  },
]);

const reconciledThread = deriveCoworkAgentThread(inspectorActivity, {
  chatId: "chat-1",
  sessionId: "cw-1",
  agentId: "researcher",
  liveStreams: threadState.liveStreams,
  completedStepIds: new Set(["step-live", "step-stale"]),
});
assert.equal(reconciledThread.some((item) => item.source === "live_stream"), false);
assert.equal(observationDetailState({ sensitive: true, detail_ref: "detail-3" }), "sensitive");
assert.equal(observationDetailState({}), "unavailable");
