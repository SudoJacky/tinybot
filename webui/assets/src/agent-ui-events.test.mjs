import assert from "node:assert/strict";

import {
  AGENT_UI_EVENT_SCHEMA_VERSION,
  AGENT_UI_EVENT_TYPES,
  AGENT_UI_FORM_FIELD_TYPES,
  AGENT_UI_FORM_LIFECYCLE_EVENT_TYPES,
  AGENT_UI_FORM_STATUSES,
  AGENT_UI_RENDERER_SURFACES,
  LEGACY_FRAME_BEHAVIOR,
  assertAgentUiPayloadIsSafe,
  buildAgentUiFormCancelRequest,
  buildAgentUiFormSubmitRequest,
  createAgentUiEventState,
  createAgentUiEventEnvelope,
  createAgentUiRendererRegistry,
  isAgentUiFormSubmittable,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  renderAgentUiSurface,
  validateAgentUiFormRequestPayload,
  validateAgentUiFormValues,
} from "./agent-ui-events.js";
import { AGENT_UI_FORM_REQUEST_FIXTURES, LEGACY_AGENT_UI_FRAME_FIXTURES } from "./agent-ui-event-fixtures.js";

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
  "ui.form.requested",
  "ui.form.updated",
  "ui.form.submitted",
  "ui.form.cancelled",
  "ui.form.expired",
  "ui.form.validation_failed",
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
assert.throws(
  () => assertAgentUiPayloadIsSafe({ renderer: "model-supplied-form-renderer" }),
  /executable UI payload/i,
);

assert.deepEqual(Object.values(AGENT_UI_FORM_LIFECYCLE_EVENT_TYPES), [
  AGENT_UI_EVENT_TYPES["ui.form.requested"],
  AGENT_UI_EVENT_TYPES["ui.form.updated"],
  AGENT_UI_EVENT_TYPES["ui.form.submitted"],
  AGENT_UI_EVENT_TYPES["ui.form.cancelled"],
  AGENT_UI_EVENT_TYPES["ui.form.expired"],
  AGENT_UI_EVENT_TYPES["ui.form.validation_failed"],
]);
assert.deepEqual(AGENT_UI_FORM_STATUSES, {
  pending: "pending",
  submitted: "submitted",
  cancelled: "cancelled",
  expired: "expired",
  validationFailed: "validation_failed",
});
assert.deepEqual(AGENT_UI_FORM_FIELD_TYPES, [
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "checkbox",
  "radio",
  "date",
  "time",
  "datetime",
  "file_path",
]);

const normalizedForm = validateAgentUiFormRequestPayload(AGENT_UI_FORM_REQUEST_FIXTURES.validRequest);
assert.equal(normalizedForm.form_id, AGENT_UI_FORM_REQUEST_FIXTURES.validRequest.form_id);
assert.equal(normalizedForm.correlation.form_id, AGENT_UI_FORM_REQUEST_FIXTURES.validRequest.form_id);
assert.equal(normalizedForm.fields.length, AGENT_UI_FORM_FIELD_TYPES.length);
assert.deepEqual(
  normalizedForm.fields.map((field) => field.type),
  AGENT_UI_FORM_FIELD_TYPES,
);
assert.doesNotThrow(() => validateAgentUiFormValues(normalizedForm, AGENT_UI_FORM_REQUEST_FIXTURES.validRequest.initial_values));
assert.throws(
  () => validateAgentUiFormValues(normalizedForm, { destination: "", nights: 31 }),
  /required|above the maximum/i,
);

for (const fixture of AGENT_UI_FORM_REQUEST_FIXTURES.invalidSchemas) {
  assert.throws(
    () => validateAgentUiFormRequestPayload(fixture.payload),
    fixture.error,
    `expected invalid form schema fixture to fail: ${fixture.name}`,
  );
}

for (const lifecycleFixture of [
  AGENT_UI_FORM_REQUEST_FIXTURES.submitted,
  AGENT_UI_FORM_REQUEST_FIXTURES.cancelled,
  AGENT_UI_FORM_REQUEST_FIXTURES.expired,
  AGENT_UI_FORM_REQUEST_FIXTURES.validationFailed,
]) {
  assert.equal(lifecycleFixture.form_id, AGENT_UI_FORM_REQUEST_FIXTURES.validRequest.form_id);
  assert.ok(Object.values(AGENT_UI_FORM_STATUSES).includes(lifecycleFixture.status));
  assert.equal(lifecycleFixture.correlation.chat_id, "chat-1");
}

const formRequestEvents = normalizeAgentUiEvents(AGENT_UI_FORM_REQUEST_FIXTURES.nativeFrames[0]);
assert.equal(formRequestEvents.length, 1);
assert.equal(formRequestEvents[0].event_type, AGENT_UI_EVENT_TYPES["ui.form.requested"]);
assert.equal(formRequestEvents[0].metadata.compatibility, "native-agent-ui-event");
assert.equal(formRequestEvents[0].payload.form_id, "travel-preferences-1");
assert.equal(formRequestEvents[0].payload.fields.length, 2);

const malformedFormEvents = normalizeAgentUiEvents({
  event: "agent_ui_event",
  chat_id: "chat-1",
  agent_ui_event: {
    event_type: AGENT_UI_EVENT_TYPES["ui.form.requested"],
    chat_id: "chat-1",
    payload: {
      form_id: "bad-form-1",
      title: "Bad form",
      correlation: { chat_id: "chat-1" },
      fields: [{ name: "unsafe", type: "text", label: "Unsafe", script: "alert(1)" }],
    },
  },
});
assert.equal(malformedFormEvents[0].event_type, AGENT_UI_EVENT_TYPES["error.raised"]);
assert.match(malformedFormEvents[0].payload.message, /executable UI payload|unsafe key/i);

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

const backendBrowserFrameEvents = normalizeAgentUiEvents({
  event: "browser_frame",
  chat_id: "chat-1",
  image_url: "data:image/png;base64,abc",
  source_command: "opencli browser state",
  captured_at: "2026-05-24T00:00:00Z",
});
assert.equal(backendBrowserFrameEvents[0].payload.command, "opencli browser state");

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
  [AGENT_UI_RENDERER_SURFACES.formRequest]: ({ form }) => `form:${form.form_id}`,
});

assert.deepEqual(
  Object.keys(AGENT_UI_RENDERER_SURFACES).sort(),
  [
    "approval",
    "browserSnapshot",
    "errorNotice",
    "formRequest",
    "memoryReferences",
    "message",
    "reasoning",
    "recentContextReferences",
    "toolRun",
    "usageStatus",
  ],
);
assert.equal(
  renderAgentUiSurface(rendererRegistry, AGENT_UI_RENDERER_SURFACES.formRequest, { form: normalizedForm }),
  "form:travel-preferences-1",
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

const formReducerState = createAgentUiEventState();
for (const frame of AGENT_UI_FORM_REQUEST_FIXTURES.nativeFrames.slice(0, 3)) {
  for (const event of normalizeAgentUiEvents(frame)) {
    reduceAgentUiEventState(formReducerState, event);
  }
}
const submittedForm = formReducerState.forms.get("travel-preferences-1");
assert.equal(submittedForm.status, AGENT_UI_FORM_STATUSES.submitted);
assert.equal(submittedForm.title, "Travel preferences");
assert.equal(submittedForm.values.destination, "Shanghai");
assert.deepEqual(submittedForm.errors, {});

const validationState = createAgentUiEventState();
for (const frame of AGENT_UI_FORM_REQUEST_FIXTURES.nativeFrames.slice(0, 2)) {
  for (const event of normalizeAgentUiEvents(frame)) {
    reduceAgentUiEventState(validationState, event);
  }
}
const validationForm = validationState.forms.get("travel-preferences-1");
assert.equal(validationForm.status, AGENT_UI_FORM_STATUSES.validationFailed);
assert.equal(validationForm.values.nights, 31);
assert.equal(validationForm.errors.destination, "Destination is required.");

const submitPayload = buildAgentUiFormSubmitRequest(normalizedForm, {
  destination: "Shanghai",
  nights: 3,
});
assert.deepEqual(submitPayload, {
  values: {
    destination: "Shanghai",
    nights: 3,
  },
  correlation: {
    form_id: "travel-preferences-1",
    session_key: "websocket:chat-1",
    chat_id: "chat-1",
    run_id: "run-1",
    message_id: "msg-form-1",
  },
});
assert.deepEqual(buildAgentUiFormCancelRequest(normalizedForm), {
  correlation: {
    form_id: "travel-preferences-1",
    session_key: "websocket:chat-1",
    chat_id: "chat-1",
    run_id: "run-1",
    message_id: "msg-form-1",
  },
});
assert.equal(isAgentUiFormSubmittable({ ...normalizedForm, submitting: true }), false);
assert.equal(buildAgentUiFormSubmitRequest({ ...normalizedForm, status: AGENT_UI_FORM_STATUSES.submitted }, {}), null);

for (const frame of AGENT_UI_FORM_REQUEST_FIXTURES.nativeFrames.slice(3)) {
  const state = createAgentUiEventState();
  for (const event of normalizeAgentUiEvents(AGENT_UI_FORM_REQUEST_FIXTURES.nativeFrames[0])) {
    reduceAgentUiEventState(state, event);
  }
  for (const event of normalizeAgentUiEvents(frame)) {
    reduceAgentUiEventState(state, event);
  }
  assert.ok([
    AGENT_UI_FORM_STATUSES.cancelled,
    AGENT_UI_FORM_STATUSES.expired,
  ].includes(state.forms.get("travel-preferences-1").status));
}
