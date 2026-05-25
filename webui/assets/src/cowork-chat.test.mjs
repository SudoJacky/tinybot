import assert from "node:assert/strict";

import {
  agentCurrentTask,
  agentDisplayLabel,
  agentRecentActivity,
  chatCoworkKey,
  coworkAgentActivityKey,
  createChatCoworkState,
  getChatCoworkSessions,
  normalizeCoworkStateEvent,
  normalizeCoworkAgentActivityPayload,
  observationDetailState,
  rememberCoworkStateEvent,
  selectVisibleChatCoworkSessions,
  summarizeCoworkTasks,
  upsertChatCoworkSession,
} from "./cowork-chat.js";

const chatCowork = createChatCoworkState();

assert.equal(chatCoworkKey("chat-1", "cw-1"), "chat-1:cw-1");
assert.equal(coworkAgentActivityKey("cw-1", "researcher"), "cw-1:researcher");
assert.equal(normalizeCoworkStateEvent({ event: "cowork_state", chat_id: "chat-1" }), null);
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

const event = normalizeCoworkStateEvent({
  event: "cowork_state",
  chat_id: "chat-1",
  session_id: "cw-1",
  change_type: "task_progress",
  agent_id: "researcher",
});
rememberCoworkStateEvent(chatCowork, event);
assert.equal(agentRecentActivity(firstSession, firstSession.agents[0], event), "task_progress");

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
assert.equal(observationDetailState({ sensitive: true, detail_ref: "detail-3" }), "sensitive");
assert.equal(observationDetailState({}), "unavailable");
