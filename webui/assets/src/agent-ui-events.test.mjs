import assert from "node:assert/strict";

import {
  AGENT_UI_EVENT_SCHEMA_VERSION,
  AGENT_UI_EVENT_TYPES,
  AGENT_UI_RENDERER_SURFACES,
  LEGACY_FRAME_BEHAVIOR,
  assertAgentUiPayloadIsSafe,
  createAgentUiEventState,
  createAgentUiEventEnvelope,
  createAgentUiRendererRegistry,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  renderAgentUiSurface,
} from "./agent-ui-events.js";
import { LEGACY_AGENT_UI_FRAME_FIXTURES } from "./agent-ui-event-fixtures.js";

const requiredEventTypes = [
  "message.delta",
  "reasoning.delta",
  "message.completed",
  "message.stream.completed",
  "tool.call.started",
  "tool.call.updated",
  "tool.call.completed",
  "approval.requested",
  "approval.resolved",
  "browser.frame.updated",
  "memory.references.updated",
  "recent_context.references.updated",
  "usage.updated",
  "session.file.updated",
  "error.raised",
];

for (const type of requiredEventTypes) {
  assert.equal(AGENT_UI_EVENT_TYPES[type], type);
}

const fixtureEvents = new Set(LEGACY_AGENT_UI_FRAME_FIXTURES.map((fixture) => fixture.frame.event));
for (const eventName of LEGACY_FRAME_BEHAVIOR.map((entry) => entry.event)) {
  assert.ok(fixtureEvents.has(eventName), `missing fixture for ${eventName}`);
}

for (const fixture of LEGACY_AGENT_UI_FRAME_FIXTURES) {
  assert.equal(typeof fixture.name, "string");
  assert.equal(typeof fixture.visibleBehavior, "string");
  assert.equal(typeof fixture.frame.event, "string");
  assert.ok(Array.isArray(fixture.normalizedEvents));
}

const envelope = createAgentUiEventEnvelope({
  eventType: AGENT_UI_EVENT_TYPES["message.delta"],
  chatId: "chat-1",
  messageId: "msg-1",
  payload: { text: "hello" },
  metadata: { source_frame: "delta" },
});

assert.equal(envelope.schema_version, AGENT_UI_EVENT_SCHEMA_VERSION);
assert.equal(envelope.event_type, "message.delta");
assert.equal(envelope.chat_id, "chat-1");
assert.equal(envelope.message_id, "msg-1");
assert.equal(envelope.payload.text, "hello");
assert.match(envelope.event_id, /^aui-/);

assert.doesNotThrow(() => assertAgentUiPayloadIsSafe({ text: "plain text", items: [1, 2, 3] }));
assert.throws(
  () => assertAgentUiPayloadIsSafe({ html: "<script>alert(1)</script>" }),
  /executable UI payload/i,
);

const coworkFixture = LEGACY_AGENT_UI_FRAME_FIXTURES.find((fixture) => fixture.frame.event === "cowork_updated");
assert.ok(coworkFixture);
assert.equal(coworkFixture.compatibilityPassthrough, true);
assert.deepEqual(coworkFixture.normalizedEvents, []);

for (const fixture of LEGACY_AGENT_UI_FRAME_FIXTURES) {
  const events = normalizeAgentUiEvents(fixture.frame);
  assert.deepEqual(
    events.map((event) => event.event_type),
    fixture.normalizedEvents,
    `unexpected normalized events for ${fixture.name}`,
  );
  for (const event of events) {
    assert.equal(event.schema_version, AGENT_UI_EVENT_SCHEMA_VERSION);
    assert.equal(event.chat_id, fixture.frame.chat_id || "");
    assert.equal(event.metadata.source_frame, fixture.frame.event);
  }
}

assert.deepEqual(normalizeAgentUiEvents(null), []);
assert.deepEqual(normalizeAgentUiEvents({ event: "unknown", chat_id: "chat-1" }), []);

const fallbackDelta = normalizeAgentUiEvents({
  event: "delta",
  chat_id: "chat-1",
  text: "no message id",
});
assert.equal(fallbackDelta[0].message_id, "legacy-stream:chat-1");

const unsafeEvents = normalizeAgentUiEvents({
  event: "message",
  chat_id: "chat-1",
  text: "unsafe",
  html: "<script>alert(1)</script>",
});
assert.equal(unsafeEvents[0].event_type, AGENT_UI_EVENT_TYPES["error.raised"]);

const rendererRegistry = createAgentUiRendererRegistry({
  [AGENT_UI_RENDERER_SURFACES.message]: ({ message }) => `message:${message.content}`,
  [AGENT_UI_RENDERER_SURFACES.reasoning]: ({ text }) => `reasoning:${text}`,
  [AGENT_UI_RENDERER_SURFACES.toolRun]: ({ name }) => `tool:${name}`,
  [AGENT_UI_RENDERER_SURFACES.approval]: ({ approvalId }) => `approval:${approvalId}`,
  [AGENT_UI_RENDERER_SURFACES.browserSnapshot]: ({ imageUrl }) => `browser:${imageUrl}`,
  [AGENT_UI_RENDERER_SURFACES.memoryReferences]: ({ references }) => `memory:${references.length}`,
  [AGENT_UI_RENDERER_SURFACES.recentContextReferences]: ({ references }) => `recent:${references.length}`,
  [AGENT_UI_RENDERER_SURFACES.usageStatus]: ({ usage }) => `usage:${usage.total_tokens}`,
  [AGENT_UI_RENDERER_SURFACES.errorNotice]: ({ message }) => `error:${message}`,
});

assert.deepEqual(
  Object.keys(AGENT_UI_RENDERER_SURFACES).sort(),
  [
    "approval",
    "browserSnapshot",
    "errorNotice",
    "memoryReferences",
    "message",
    "reasoning",
    "recentContextReferences",
    "toolRun",
    "usageStatus",
  ],
);
assert.equal(
  renderAgentUiSurface(rendererRegistry, AGENT_UI_RENDERER_SURFACES.toolRun, { name: "read_file" }),
  "tool:read_file",
);
assert.equal(renderAgentUiSurface(rendererRegistry, "model.supplied.renderer", {}), null);
assert.equal(typeof rendererRegistry.register, "undefined");
assert.throws(
  () => {
    rendererRegistry[AGENT_UI_RENDERER_SURFACES.toolRun] = () => "mutated";
  },
  /read only|Cannot assign/i,
);

const reducerState = createAgentUiEventState();
for (const fixture of LEGACY_AGENT_UI_FRAME_FIXTURES) {
  for (const event of normalizeAgentUiEvents(fixture.frame)) {
    reduceAgentUiEventState(reducerState, event);
  }
}

assert.equal(reducerState.streams.get("msg-1").content, "Hello");
assert.equal(reducerState.streams.get("msg-1").reasoning_content, "Plan");
assert.equal(reducerState.streams.get("msg-1").completed, true);
assert.deepEqual(reducerState.memoryReferences.get("msg-1"), [{ id: "mem-1" }]);
assert.deepEqual(reducerState.recentContextReferences.get("msg-1"), [{ id: "ctx-1" }]);
assert.equal(reducerState.messages.get("msg-2").content, "Final answer");
assert.equal(reducerState.toolRuns.size, 2);
assert.ok(reducerState.approvals.has("approval-1"));
assert.equal(reducerState.browserFrame.image_url, "/browser/snapshot.png");
assert.equal(reducerState.usage.total_tokens, 15);
assert.equal(reducerState.sessionFiles.at(-1).path, "notes.md");
assert.equal(reducerState.errors.at(-1).message, "Server error");
