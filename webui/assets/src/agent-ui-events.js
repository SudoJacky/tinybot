export const AGENT_UI_EVENT_SCHEMA_VERSION = "agent-ui.event.v1";

export const AGENT_UI_EVENT_TYPES = Object.freeze({
  "message.delta": "message.delta",
  "reasoning.delta": "reasoning.delta",
  "message.completed": "message.completed",
  "message.stream.completed": "message.stream.completed",
  "tool.call.started": "tool.call.started",
  "tool.call.updated": "tool.call.updated",
  "tool.call.completed": "tool.call.completed",
  "approval.requested": "approval.requested",
  "approval.resolved": "approval.resolved",
  "browser.frame.updated": "browser.frame.updated",
  "memory.references.updated": "memory.references.updated",
  "recent_context.references.updated": "recent_context.references.updated",
  "usage.updated": "usage.updated",
  "session.file.updated": "session.file.updated",
  "error.raised": "error.raised",
  "ui.form.requested": "ui.form.requested",
  "ui.form.updated": "ui.form.updated",
  "ui.form.submitted": "ui.form.submitted",
  "ui.form.cancelled": "ui.form.cancelled",
  "ui.form.expired": "ui.form.expired",
  "ui.form.validation_failed": "ui.form.validation_failed",
});

export const AGENT_UI_RENDERER_SURFACES = Object.freeze({
  message: "message",
  reasoning: "reasoning",
  toolRun: "toolRun",
  approval: "approval",
  browserSnapshot: "browserSnapshot",
  memoryReferences: "memoryReferences",
  recentContextReferences: "recentContextReferences",
  usageStatus: "usageStatus",
  errorNotice: "errorNotice",
  formRequest: "formRequest",
});

const AGENT_UI_RENDERER_SURFACE_VALUES = new Set(Object.values(AGENT_UI_RENDERER_SURFACES));

export const AGENT_UI_FORM_LIFECYCLE_EVENT_TYPES = Object.freeze({
  requested: AGENT_UI_EVENT_TYPES["ui.form.requested"],
  updated: AGENT_UI_EVENT_TYPES["ui.form.updated"],
  submitted: AGENT_UI_EVENT_TYPES["ui.form.submitted"],
  cancelled: AGENT_UI_EVENT_TYPES["ui.form.cancelled"],
  expired: AGENT_UI_EVENT_TYPES["ui.form.expired"],
  validationFailed: AGENT_UI_EVENT_TYPES["ui.form.validation_failed"],
});

export const AGENT_UI_FORM_FIELD_TYPES = Object.freeze([
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

export const AGENT_UI_FORM_STATUSES = Object.freeze({
  pending: "pending",
  submitted: "submitted",
  cancelled: "cancelled",
  expired: "expired",
  validationFailed: "validation_failed",
});

const AGENT_UI_FORM_FIELD_TYPE_VALUES = new Set(AGENT_UI_FORM_FIELD_TYPES);
const CHOICE_FIELD_TYPES = new Set(["select", "multiselect", "radio"]);
const STRING_FIELD_TYPES = new Set(["text", "textarea", "date", "time", "datetime", "file_path"]);
const FORM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FORM_FIELDS = 50;
const MAX_FORM_OPTIONS = 100;
const MAX_FORM_TEXT_LENGTH = 2000;

export const LEGACY_FRAME_BEHAVIOR = Object.freeze([
  {
    event: "chat_created",
    visibleBehavior: "Activates the created chat, refreshes sessions, and sends any pending user message.",
    normalizedEvents: [],
  },
  {
    event: "attached",
    visibleBehavior: "Activates the attached chat and reloads persisted messages through the session route.",
    normalizedEvents: [],
  },
  {
    event: "delta",
    visibleBehavior: "Appends assistant or reasoning stream content to the live message buffer.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["message.delta"], AGENT_UI_EVENT_TYPES["reasoning.delta"]],
  },
  {
    event: "message",
    visibleBehavior: "Adds assistant, progress, tool, task, memory, and recent-context message surfaces.",
    normalizedEvents: [
      AGENT_UI_EVENT_TYPES["message.completed"],
      AGENT_UI_EVENT_TYPES["tool.call.started"],
      AGENT_UI_EVENT_TYPES["tool.call.updated"],
      AGENT_UI_EVENT_TYPES["tool.call.completed"],
      AGENT_UI_EVENT_TYPES["memory.references.updated"],
      AGENT_UI_EVENT_TYPES["recent_context.references.updated"],
    ],
  },
  {
    event: "stream_end",
    visibleBehavior: "Finalizes a live stream and attaches memory or recent-context references to the message.",
    normalizedEvents: [
      AGENT_UI_EVENT_TYPES["message.stream.completed"],
      AGENT_UI_EVENT_TYPES["memory.references.updated"],
      AGENT_UI_EVENT_TYPES["recent_context.references.updated"],
    ],
  },
  {
    event: "approval_pending",
    visibleBehavior: "Refreshes approval cards through the existing approval control route.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["approval.requested"]],
  },
  {
    event: "browser_frame",
    visibleBehavior: "Updates the existing browser snapshot panel with the latest frame.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["browser.frame.updated"]],
  },
  {
    event: "browser_snapshot",
    visibleBehavior: "Updates the existing browser snapshot panel with a captured snapshot.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["browser.frame.updated"]],
  },
  {
    event: "usage",
    visibleBehavior: "Updates the token usage status surface.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["usage.updated"]],
  },
  {
    event: "file_updated",
    visibleBehavior: "Reloads editable file metadata and refreshes or warns on the active editor file.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["session.file.updated"]],
  },
  {
    event: "error",
    visibleBehavior: "Shows a safe error notice and mirrors file-related errors to the editor status.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["error.raised"]],
  },
  {
    event: "cowork_updated",
    visibleBehavior: "Schedules a Cowork snapshot refresh without entering the home-page Agent UI reducer.",
    normalizedEvents: [],
    compatibilityPassthrough: true,
  },
  {
    event: "cowork_state",
    visibleBehavior: "Refreshes a chat-scoped Cowork Agent Swarm snapshot without entering the home-page Agent UI reducer.",
    normalizedEvents: [],
    compatibilityPassthrough: true,
  },
]);

const UNSAFE_PAYLOAD_KEYS = new Set([
  "html",
  "innerHTML",
  "outerHTML",
  "script",
  "scripts",
  "style",
  "styles",
  "css",
  "dom",
  "rawDom",
  "component",
  "componentDefinition",
  "renderer",
  "renderers",
  "rendererRegistry",
  "registerRenderer",
  "runtimeRenderer",
  "template",
  "templates",
]);

const UNSAFE_FORM_SCHEMA_KEYS = new Set([
  ...UNSAFE_PAYLOAD_KEYS,
  "action",
  "actions",
  "handler",
  "handlers",
  "onChange",
  "onClick",
  "onSubmit",
  "onCancel",
  "onRender",
]);

let fallbackEventCounter = 0;

function generateEventId() {
  if (globalThis.crypto?.randomUUID) {
    return `aui-${globalThis.crypto.randomUUID()}`;
  }
  fallbackEventCounter += 1;
  return `aui-${Date.now()}-${fallbackEventCounter}`;
}

function assertJsonSafe(value, path = "payload") {
  if (value === null) {
    return;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return;
  }
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol" || valueType === "bigint") {
    throw new TypeError(`Agent UI event ${path} must be JSON-safe.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (valueType === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_PAYLOAD_KEYS.has(key)) {
        throw new TypeError("Agent UI event rejected executable UI payload.");
      }
      assertJsonSafe(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`Agent UI event ${path} must be JSON-safe.`);
}

export function assertAgentUiPayloadIsSafe(payload) {
  assertJsonSafe(payload);
  return payload;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoUnsafeFormSchemaKeys(value, path = "form") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeFormSchemaKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_FORM_SCHEMA_KEYS.has(key)) {
      throw new TypeError(`Agent UI form schema rejected unsafe key: ${path}.${key}`);
    }
    assertNoUnsafeFormSchemaKeys(item, `${path}.${key}`);
  }
}

function normalizeOptionalString(value, path, maxLength = 512) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`Agent UI form ${path} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new TypeError(`Agent UI form ${path} is too long.`);
  }
  return trimmed;
}

function normalizeRequiredString(value, path, maxLength = 512) {
  const normalized = normalizeOptionalString(value, path, maxLength);
  if (!normalized) {
    throw new TypeError(`Agent UI form ${path} is required.`);
  }
  return normalized;
}

function assertSafeFieldName(name, path) {
  if (!FIELD_NAME_RE.test(name) || RESERVED_FIELD_NAMES.has(name)) {
    throw new TypeError(`Agent UI form ${path} has an unsafe field name.`);
  }
}

function normalizeFormOption(option, path) {
  if (!isPlainObject(option)) {
    throw new TypeError(`Agent UI form ${path} must be an object.`);
  }
  const label = normalizeRequiredString(option.label, `${path}.label`, 256);
  const value = option.value;
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new TypeError(`Agent UI form ${path}.value must be a string, number, or boolean.`);
  }
  return { label, value };
}

function normalizedOptionValues(field) {
  return new Set((field.options || []).map((option) => option.value));
}

function validateValueAgainstField(field, value, path) {
  if (value === undefined || value === null || value === "") {
    if (field.required) {
      throw new TypeError(`Agent UI form ${path} is required.`);
    }
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`Agent UI form ${path} must be a finite number.`);
    }
    if (typeof field.min === "number" && value < field.min) {
      throw new TypeError(`Agent UI form ${path} is below the minimum.`);
    }
    if (typeof field.max === "number" && value > field.max) {
      throw new TypeError(`Agent UI form ${path} is above the maximum.`);
    }
    return;
  }
  if (field.type === "checkbox") {
    if (typeof value !== "boolean") {
      throw new TypeError(`Agent UI form ${path} must be a boolean.`);
    }
    return;
  }
  if (field.type === "multiselect") {
    if (!Array.isArray(value)) {
      throw new TypeError(`Agent UI form ${path} must be an array.`);
    }
    const optionValues = normalizedOptionValues(field);
    for (const item of value) {
      if (!optionValues.has(item)) {
        throw new TypeError(`Agent UI form ${path} contains an unsupported option.`);
      }
    }
    return;
  }
  if (CHOICE_FIELD_TYPES.has(field.type)) {
    if (!normalizedOptionValues(field).has(value)) {
      throw new TypeError(`Agent UI form ${path} contains an unsupported option.`);
    }
    return;
  }
  if (STRING_FIELD_TYPES.has(field.type)) {
    if (typeof value !== "string") {
      throw new TypeError(`Agent UI form ${path} must be a string.`);
    }
    if (value.length > MAX_FORM_TEXT_LENGTH) {
      throw new TypeError(`Agent UI form ${path} is too long.`);
    }
    if (typeof field.min_length === "number" && value.length < field.min_length) {
      throw new TypeError(`Agent UI form ${path} is shorter than the minimum length.`);
    }
    if (typeof field.max_length === "number" && value.length > field.max_length) {
      throw new TypeError(`Agent UI form ${path} is longer than the maximum length.`);
    }
    if (field.pattern) {
      const pattern = new RegExp(field.pattern);
      if (!pattern.test(value)) {
        throw new TypeError(`Agent UI form ${path} does not match the required pattern.`);
      }
    }
  }
}

function normalizeFormField(field, index) {
  const path = `fields[${index}]`;
  if (!isPlainObject(field)) {
    throw new TypeError(`Agent UI form ${path} must be an object.`);
  }
  const name = normalizeRequiredString(field.name, `${path}.name`, 64);
  assertSafeFieldName(name, path);
  const type = normalizeRequiredString(field.type, `${path}.type`, 64);
  if (!AGENT_UI_FORM_FIELD_TYPE_VALUES.has(type)) {
    throw new TypeError(`Agent UI form ${path}.type is unsupported.`);
  }
  const normalized = {
    name,
    type,
    label: normalizeRequiredString(field.label, `${path}.label`, 256),
    required: field.required === true,
  };
  for (const key of ["placeholder", "help"]) {
    const value = normalizeOptionalString(field[key], `${path}.${key}`, 512);
    if (value) {
      normalized[key] = value;
    }
  }
  for (const key of ["min", "max", "min_length", "max_length"]) {
    if (field[key] !== undefined) {
      if (typeof field[key] !== "number" || !Number.isFinite(field[key])) {
        throw new TypeError(`Agent UI form ${path}.${key} must be a finite number.`);
      }
      normalized[key] = field[key];
    }
  }
  if (field.pattern !== undefined) {
    normalized.pattern = normalizeRequiredString(field.pattern, `${path}.pattern`, 256);
    new RegExp(normalized.pattern);
  }
  if (CHOICE_FIELD_TYPES.has(type)) {
    if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > MAX_FORM_OPTIONS) {
      throw new TypeError(`Agent UI form ${path}.options must be a bounded non-empty array.`);
    }
    normalized.options = field.options.map((option, optionIndex) => normalizeFormOption(option, `${path}.options[${optionIndex}]`));
  } else if (field.options !== undefined) {
    throw new TypeError(`Agent UI form ${path}.options is only allowed for choice fields.`);
  }
  if (field.default !== undefined) {
    validateValueAgainstField(normalized, field.default, `${path}.default`);
    normalized.default = field.default;
  }
  return normalized;
}

export function validateAgentUiFormValues(form, values = {}) {
  const schema = validateAgentUiFormRequestPayload(form);
  if (!isPlainObject(values)) {
    throw new TypeError("Agent UI form values must be an object.");
  }
  for (const field of schema.fields) {
    validateValueAgainstField(field, values[field.name], `values.${field.name}`);
  }
  return values;
}

export function validateAgentUiFormRequestPayload(payload) {
  assertAgentUiPayloadIsSafe(payload);
  assertNoUnsafeFormSchemaKeys(payload);
  if (!isPlainObject(payload)) {
    throw new TypeError("Agent UI form payload must be an object.");
  }
  const formId = normalizeRequiredString(payload.form_id, "form_id", 128);
  if (!FORM_ID_RE.test(formId)) {
    throw new TypeError("Agent UI form form_id is unsafe.");
  }
  const fields = payload.fields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FORM_FIELDS) {
    throw new TypeError("Agent UI form fields must be a bounded non-empty array.");
  }
  const normalizedFields = fields.map((field, index) => normalizeFormField(field, index));
  const fieldNames = new Set();
  for (const field of normalizedFields) {
    if (fieldNames.has(field.name)) {
      throw new TypeError(`Agent UI form field name is duplicated: ${field.name}`);
    }
    fieldNames.add(field.name);
  }
  const correlation = payload.correlation;
  if (!isPlainObject(correlation)) {
    throw new TypeError("Agent UI form correlation is required.");
  }
  assertJsonSafe(correlation, "correlation");
  const normalized = {
    form_id: formId,
    title: normalizeRequiredString(payload.title, "title", 256),
    fields: normalizedFields,
    correlation: { ...correlation, form_id: correlation.form_id || formId },
  };
  for (const key of ["description", "submit_label", "cancel_label"]) {
    const value = normalizeOptionalString(payload[key], key, 1024);
    if (value) {
      normalized[key] = value;
    }
  }
  if (payload.expires_at !== undefined && payload.expires_at !== null) {
    const expiresAt = normalizeRequiredString(payload.expires_at, "expires_at", 128);
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new TypeError("Agent UI form expires_at must be an ISO timestamp.");
    }
    normalized.expires_at = expiresAt;
  }
  if (payload.initial_values !== undefined) {
    validateAgentUiFormValues(normalized, payload.initial_values);
    normalized.initial_values = { ...payload.initial_values };
  }
  if (payload.metadata !== undefined) {
    if (!isPlainObject(payload.metadata)) {
      throw new TypeError("Agent UI form metadata must be an object.");
    }
    normalized.metadata = { ...payload.metadata };
  }
  return normalized;
}

export function createAgentUiEventEnvelope({
  eventType,
  chatId,
  messageId = "",
  runId = "",
  parentId = "",
  timestamp = new Date().toISOString(),
  payload = {},
  metadata = {},
}) {
  if (!Object.hasOwn(AGENT_UI_EVENT_TYPES, eventType)) {
    throw new TypeError(`Unknown Agent UI event type: ${eventType}`);
  }
  if (!chatId) {
    throw new TypeError("Agent UI event requires chatId.");
  }
  assertAgentUiPayloadIsSafe(payload);
  assertJsonSafe(metadata, "metadata");

  return {
    schema_version: AGENT_UI_EVENT_SCHEMA_VERSION,
    event_id: generateEventId(),
    event_type: eventType,
    chat_id: chatId,
    message_id: messageId,
    run_id: runId,
    parent_id: parentId,
    timestamp,
    payload,
    metadata,
  };
}

export function createAgentUiRendererRegistry(renderers = {}) {
  const registry = {};
  for (const surface of Object.values(AGENT_UI_RENDERER_SURFACES)) {
    const renderer = renderers[surface];
    if (renderer !== undefined && typeof renderer !== "function") {
      throw new TypeError(`Agent UI renderer for ${surface} must be a function.`);
    }
    Object.defineProperty(registry, surface, {
      value: renderer || null,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(registry);
}

export function renderAgentUiSurface(registry, surface, context = {}) {
  if (!AGENT_UI_RENDERER_SURFACE_VALUES.has(surface)) {
    return null;
  }
  const renderer = registry?.[surface];
  if (typeof renderer !== "function") {
    return null;
  }
  return renderer(context);
}

export function isAgentUiFormSubmittable(form) {
  if (!form || form.submitting === true) {
    return false;
  }
  return ![
    AGENT_UI_FORM_STATUSES.submitted,
    AGENT_UI_FORM_STATUSES.cancelled,
    AGENT_UI_FORM_STATUSES.expired,
  ].includes(form.status);
}

export function buildAgentUiFormSubmitRequest(form, values = {}) {
  if (!isAgentUiFormSubmittable(form)) {
    return null;
  }
  return {
    values: isPlainObject(values) ? { ...values } : {},
    correlation: isPlainObject(form.correlation) ? { ...form.correlation } : {},
  };
}

export function buildAgentUiFormCancelRequest(form) {
  if (!isAgentUiFormSubmittable(form)) {
    return null;
  }
  return {
    correlation: isPlainObject(form.correlation) ? { ...form.correlation } : {},
  };
}

function legacyStreamMessageId(frame) {
  return frame.message_id || frame.run_id || (frame.chat_id ? `legacy-stream:${frame.chat_id}` : "");
}

function hasArrayItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function createLegacyEnvelope(frame, eventType, payload, fields = {}) {
  return createAgentUiEventEnvelope({
    eventType,
    chatId: frame.chat_id || "",
    messageId: fields.messageId ?? frame.message_id ?? "",
    runId: fields.runId ?? frame.run_id ?? "",
    parentId: fields.parentId ?? frame.parent_id ?? "",
    timestamp: frame.timestamp || frame.created_at || new Date().toISOString(),
    payload,
    metadata: {
      source_frame: frame.event,
      compatibility: "legacy-websocket-frame",
      ...(fields.metadata || {}),
    },
  });
}

function normalizeFormLifecyclePayload(eventType, payload) {
  assertAgentUiPayloadIsSafe(payload);
  assertNoUnsafeFormSchemaKeys(payload);
  if (eventType === AGENT_UI_EVENT_TYPES["ui.form.requested"]) {
    return validateAgentUiFormRequestPayload(payload);
  }
  if (!isPlainObject(payload)) {
    throw new TypeError("Agent UI form lifecycle payload must be an object.");
  }
  const formId = normalizeRequiredString(payload.form_id, "form_id", 128);
  if (!FORM_ID_RE.test(formId)) {
    throw new TypeError("Agent UI form form_id is unsafe.");
  }
  const normalized = {
    ...payload,
    form_id: formId,
    correlation: isPlainObject(payload.correlation) ? { ...payload.correlation, form_id: payload.correlation.form_id || formId } : { form_id: formId },
  };
  if (payload.values !== undefined && !isPlainObject(payload.values)) {
    throw new TypeError("Agent UI form lifecycle values must be an object.");
  }
  if (payload.errors !== undefined && !isPlainObject(payload.errors)) {
    throw new TypeError("Agent UI form lifecycle errors must be an object.");
  }
  return normalized;
}

function isFormLifecycleEventType(eventType) {
  return Object.values(AGENT_UI_FORM_LIFECYCLE_EVENT_TYPES).includes(eventType);
}

function normalizeNativeAgentUiEventFrame(frame) {
  const source = isPlainObject(frame.agent_ui_event) ? frame.agent_ui_event : frame;
  const eventType = source.event_type || source.type || "";
  if (!Object.hasOwn(AGENT_UI_EVENT_TYPES, eventType)) {
    throw new TypeError(`Unknown Agent UI event type: ${eventType}`);
  }
  const payload = isPlainObject(source.payload) ? source.payload : {};
  const normalizedPayload = isFormLifecycleEventType(eventType)
    ? normalizeFormLifecyclePayload(eventType, payload)
    : assertAgentUiPayloadIsSafe(payload);
  return {
    schema_version: source.schema_version || AGENT_UI_EVENT_SCHEMA_VERSION,
    event_id: source.event_id || generateEventId(),
    event_type: eventType,
    chat_id: source.chat_id || frame.chat_id || normalizedPayload.correlation?.chat_id || "",
    message_id: source.message_id || normalizedPayload.correlation?.message_id || "",
    run_id: source.run_id || normalizedPayload.correlation?.run_id || "",
    parent_id: source.parent_id || normalizedPayload.correlation?.parent_id || "",
    timestamp: source.timestamp || frame.timestamp || new Date().toISOString(),
    payload: normalizedPayload,
    metadata: {
      ...(isPlainObject(source.metadata) ? source.metadata : {}),
      source_frame: frame.event || "agent_ui_event",
      compatibility: "native-agent-ui-event",
    },
  };
}

function referenceEvents(frame, messageId) {
  const events = [];
  if (hasArrayItems(frame._memory_references)) {
    events.push(createLegacyEnvelope(
      frame,
      AGENT_UI_EVENT_TYPES["memory.references.updated"],
      { references: frame._memory_references },
      { messageId },
    ));
  }
  if (hasArrayItems(frame._recent_context_references)) {
    events.push(createLegacyEnvelope(
      frame,
      AGENT_UI_EVENT_TYPES["recent_context.references.updated"],
      { references: frame._recent_context_references },
      { messageId },
    ));
  }
  return events;
}

function normalizeMessageFrame(frame) {
  const messageId = frame.message_id || "";
  if (frame._progress) {
    let eventType = AGENT_UI_EVENT_TYPES["tool.call.updated"];
    if (frame._tool_result || frame.role === "tool") {
      eventType = AGENT_UI_EVENT_TYPES["tool.call.completed"];
    } else if (Array.isArray(frame.tool_calls) || frame._tool_hint) {
      eventType = AGENT_UI_EVENT_TYPES["tool.call.started"];
    }
    return [createLegacyEnvelope(frame, eventType, {
      text: frame.text || "",
      tool_name: frame._tool_name || frame.name || "",
      tool_call_id: frame.tool_call_id || frame._tool_call_id || "",
      approval_id: frame._approval_id || "",
      approval_status: frame._approval_status || "",
      task_progress: frame._task_progress || null,
      task_event: frame._task_event === true,
    }, { messageId })];
  }

  const events = [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["message.completed"], {
    text: frame.text || "",
    role: frame.role || "assistant",
  }, { messageId })];
  events.push(...referenceEvents(frame, messageId));
  return events;
}

function normalizeStreamEndFrame(frame) {
  const messageId = frame.message_id || "";
  const events = [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["message.stream.completed"], {
    resuming: frame.resuming === true,
  }, { messageId })];
  events.push(...referenceEvents(frame, messageId));
  return events;
}

function normalizeKnownAgentUiFrame(frame) {
  switch (frame.event) {
    case "delta": {
      const messageId = legacyStreamMessageId(frame);
      return [createLegacyEnvelope(
        frame,
        frame.is_reasoning ? AGENT_UI_EVENT_TYPES["reasoning.delta"] : AGENT_UI_EVENT_TYPES["message.delta"],
        { text: frame.text || "", is_reasoning: frame.is_reasoning === true },
        { messageId },
      )];
    }
    case "message":
      return normalizeMessageFrame(frame);
    case "stream_end":
      return normalizeStreamEndFrame(frame);
    case "approval_pending":
      return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["approval.requested"], {
        approval_id: frame.approval_id || frame._approval_id || "",
      })];
    case "browser_frame":
    case "browser_snapshot":
      return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["browser.frame.updated"], {
        image_url: frame.image_url || frame.url || "",
        command: frame.command || frame.source_command || "",
        captured_at: frame.captured_at || frame.timestamp || "",
      })];
    case "usage":
      return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["usage.updated"], {
        usage: frame.usage || {},
      })];
    case "file_updated":
      return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["session.file.updated"], {
        path: frame.path || "",
      })];
    case "error":
      return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["error.raised"], {
        message: frame.message || "",
        path: frame.path || "",
      })];
    default:
      return [];
  }
}

export function normalizeAgentUiEvents(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || !frame.event) {
    return [];
  }
  if (frame.event === "agent_ui_event") {
    try {
      const event = normalizeNativeAgentUiEventFrame(frame);
      if (!event.chat_id) {
        return [];
      }
      return [event];
    } catch (error) {
      return [createAgentUiEventEnvelope({
        eventType: AGENT_UI_EVENT_TYPES["error.raised"],
        chatId: frame.chat_id || "agent-ui",
        payload: {
          message: error?.message || "Agent UI event normalization failed.",
          source_event: frame.event,
        },
        metadata: { source_frame: frame.event },
      })];
    }
  }
  if (frame.event === "chat_created" || frame.event === "attached" || frame.event === "cowork_updated" || frame.event === "cowork_state") {
    return [];
  }
  if (!frame.chat_id) {
    return [];
  }

  try {
    assertAgentUiPayloadIsSafe(frame);
    return normalizeKnownAgentUiFrame(frame);
  } catch (error) {
    return [createLegacyEnvelope(frame, AGENT_UI_EVENT_TYPES["error.raised"], {
      message: error?.message || "Agent UI event normalization failed.",
      source_event: frame.event,
    })];
  }
}

export function createAgentUiEventState() {
  return {
    streams: new Map(),
    messages: new Map(),
    toolRuns: new Map(),
    approvals: new Map(),
    browserFrame: null,
    usage: null,
    forms: new Map(),
    memoryReferences: new Map(),
    recentContextReferences: new Map(),
    sessionFiles: [],
    errors: [],
  };
}

function ensureStreamState(agentUiState, messageId) {
  const key = messageId || "legacy-stream";
  if (!agentUiState.streams.has(key)) {
    agentUiState.streams.set(key, {
      message_id: key,
      content: "",
      reasoning_content: "",
      completed: false,
    });
  }
  return agentUiState.streams.get(key);
}

function toolRunKey(event) {
  return (
    event.payload.tool_call_id ||
    event.payload.approval_id ||
    event.message_id ||
    `${event.event_type}:${event.event_id}`
  );
}

function formIdFromEvent(event) {
  return event.payload?.form_id || event.metadata?.form_id || event.event_id || "";
}

function reduceFormEventState(agentUiState, event, status) {
  const formId = formIdFromEvent(event);
  if (!formId) {
    return agentUiState;
  }
  const existing = agentUiState.forms.get(formId) || {};
  const next = {
    ...existing,
    form_id: formId,
    chat_id: event.chat_id || existing.chat_id || "",
    message_id: event.message_id || existing.message_id || "",
    run_id: event.run_id || existing.run_id || "",
    status,
    updated_at: event.timestamp,
    correlation: {
      ...(existing.correlation || {}),
      ...(event.payload.correlation || {}),
      form_id: formId,
    },
  };
  if (event.event_type === AGENT_UI_EVENT_TYPES["ui.form.requested"]) {
    next.status = AGENT_UI_FORM_STATUSES.pending;
    next.schema = event.payload;
    next.title = event.payload.title || "";
    next.description = event.payload.description || "";
    next.fields = event.payload.fields || [];
    next.expires_at = event.payload.expires_at || "";
    next.submit_label = event.payload.submit_label || "";
    next.cancel_label = event.payload.cancel_label || "";
    next.values = event.payload.initial_values || {};
    next.errors = {};
  } else if (event.event_type === AGENT_UI_EVENT_TYPES["ui.form.validation_failed"]) {
    next.status = AGENT_UI_FORM_STATUSES.validationFailed;
    next.values = event.payload.values || existing.values || {};
    next.errors = event.payload.errors || {};
  } else {
    next.values = event.payload.values || existing.values || {};
    next.errors = {};
  }
  agentUiState.forms.set(formId, next);
  return agentUiState;
}

export function reduceAgentUiEventState(agentUiState, event) {
  if (!agentUiState || !event || event.schema_version !== AGENT_UI_EVENT_SCHEMA_VERSION) {
    return agentUiState;
  }

  switch (event.event_type) {
    case AGENT_UI_EVENT_TYPES["message.delta"]: {
      const stream = ensureStreamState(agentUiState, event.message_id);
      stream.content += event.payload.text || "";
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["reasoning.delta"]: {
      const stream = ensureStreamState(agentUiState, event.message_id);
      stream.reasoning_content += event.payload.text || "";
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["message.stream.completed"]: {
      const stream = ensureStreamState(agentUiState, event.message_id);
      stream.completed = true;
      stream.resuming = event.payload.resuming === true;
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["message.completed"]:
      agentUiState.messages.set(event.message_id || event.event_id, {
        message_id: event.message_id,
        chat_id: event.chat_id,
        role: event.payload.role || "assistant",
        content: event.payload.text || "",
      });
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["tool.call.started"]:
    case AGENT_UI_EVENT_TYPES["tool.call.updated"]:
    case AGENT_UI_EVENT_TYPES["tool.call.completed"]: {
      const key = toolRunKey(event);
      const existing = agentUiState.toolRuns.get(key) || {};
      agentUiState.toolRuns.set(key, {
        ...existing,
        key,
        status: event.event_type.split(".").at(-1),
        message_id: event.message_id,
        tool_name: event.payload.tool_name || existing.tool_name || "",
        tool_call_id: event.payload.tool_call_id || existing.tool_call_id || "",
        approval_id: event.payload.approval_id || existing.approval_id || "",
        approval_status: event.payload.approval_status || existing.approval_status || "",
        text: event.payload.text || existing.text || "",
        task_progress: event.payload.task_progress || existing.task_progress || null,
        task_event: event.payload.task_event === true || existing.task_event === true,
      });
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["approval.requested"]: {
      const key = event.payload.approval_id || event.event_id;
      agentUiState.approvals.set(key, {
        approval_id: event.payload.approval_id || "",
        chat_id: event.chat_id,
        status: "pending",
      });
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["approval.resolved"]: {
      const key = event.payload.approval_id || event.event_id;
      agentUiState.approvals.set(key, {
        approval_id: event.payload.approval_id || "",
        chat_id: event.chat_id,
        status: event.payload.status || "resolved",
      });
      return agentUiState;
    }
    case AGENT_UI_EVENT_TYPES["browser.frame.updated"]:
      agentUiState.browserFrame = {
        image_url: event.payload.image_url || "",
        command: event.payload.command || "",
        captured_at: event.payload.captured_at || "",
      };
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["memory.references.updated"]:
      agentUiState.memoryReferences.set(event.message_id || event.event_id, event.payload.references || []);
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["recent_context.references.updated"]:
      agentUiState.recentContextReferences.set(event.message_id || event.event_id, event.payload.references || []);
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["usage.updated"]:
      agentUiState.usage = event.payload.usage || {};
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["session.file.updated"]:
      agentUiState.sessionFiles.push({ path: event.payload.path || "", timestamp: event.timestamp });
      return agentUiState;
    case AGENT_UI_EVENT_TYPES["ui.form.requested"]:
      return reduceFormEventState(agentUiState, event, AGENT_UI_FORM_STATUSES.pending);
    case AGENT_UI_EVENT_TYPES["ui.form.submitted"]:
      return reduceFormEventState(agentUiState, event, AGENT_UI_FORM_STATUSES.submitted);
    case AGENT_UI_EVENT_TYPES["ui.form.cancelled"]:
      return reduceFormEventState(agentUiState, event, AGENT_UI_FORM_STATUSES.cancelled);
    case AGENT_UI_EVENT_TYPES["ui.form.expired"]:
      return reduceFormEventState(agentUiState, event, AGENT_UI_FORM_STATUSES.expired);
    case AGENT_UI_EVENT_TYPES["ui.form.validation_failed"]:
      return reduceFormEventState(agentUiState, event, AGENT_UI_FORM_STATUSES.validationFailed);
    case AGENT_UI_EVENT_TYPES["ui.form.updated"]:
      return reduceFormEventState(agentUiState, event, event.payload.status || AGENT_UI_FORM_STATUSES.pending);
    case AGENT_UI_EVENT_TYPES["error.raised"]:
      agentUiState.errors.push({
        message: event.payload.message || "",
        path: event.payload.path || "",
        timestamp: event.timestamp,
      });
      return agentUiState;
    default:
      return agentUiState;
  }
}
