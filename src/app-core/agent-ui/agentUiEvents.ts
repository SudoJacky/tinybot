export const AGENT_UI_EVENT_SCHEMA_VERSION = "agent-ui.event.v1";

export const AGENT_UI_EVENT_TYPES = {
  "browser.frame.updated": "browser.frame.updated",
  "error.raised": "error.raised",
  "ui.form.requested": "ui.form.requested",
  "ui.form.updated": "ui.form.updated",
  "ui.form.submitted": "ui.form.submitted",
  "ui.form.cancelled": "ui.form.cancelled",
  "ui.form.expired": "ui.form.expired",
  "ui.form.validation_failed": "ui.form.validation_failed",
} as const;

export const AGENT_UI_FORM_STATUSES = {
  pending: "pending",
  submitted: "submitted",
  cancelled: "cancelled",
  expired: "expired",
  validationFailed: "validation_failed",
} as const;

export type AgentUiFormStatus = (typeof AGENT_UI_FORM_STATUSES)[keyof typeof AGENT_UI_FORM_STATUSES];

const FORM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "select", "multiselect", "checkbox", "radio", "date", "time", "datetime", "file_path"]);
const CHOICE_FIELD_TYPES = new Set(["select", "multiselect", "radio"]);
const STRING_FIELD_TYPES = new Set(["text", "textarea", "date", "time", "datetime", "file_path"]);
const UNSAFE_PAYLOAD_KEYS = new Set(["html", "innerHTML", "outerHTML", "script", "scripts", "style", "styles", "css", "dom", "rawDom", "component", "componentDefinition", "renderer", "renderers", "rendererRegistry", "registerRenderer", "runtimeRenderer", "template", "templates"]);
const UNSAFE_FORM_SCHEMA_KEYS = new Set([...UNSAFE_PAYLOAD_KEYS, "action", "actions", "handler", "handlers", "onChange", "onClick", "onSubmit", "onCancel", "onRender"]);
const MAX_FORM_FIELDS = 50;
const MAX_FORM_OPTIONS = 100;
const MAX_FORM_TEXT_LENGTH = 2000;

export type AgentUiFormField = {
  name: string;
  type: string;
  label: string;
  required: boolean;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  options?: { label: string; value: string | number | boolean }[];
  default?: unknown;
};

export type AgentUiForm = {
  form_id: string;
  title: string;
  description?: string;
  fields: AgentUiFormField[];
  correlation: Record<string, unknown>;
  submit_label?: string;
  cancel_label?: string;
  expires_at?: string;
  initial_values?: Record<string, unknown>;
  values?: Record<string, unknown>;
  errors?: Record<string, string>;
  status?: AgentUiFormStatus;
  submitting?: boolean;
  updated_at?: string;
  chat_id?: string;
  message_id?: string;
  turn_id?: string;
};

export type AgentUiBrowserFrame = {
  image_url: string;
  command: string;
  captured_at: string;
};

export type AgentUiEvent = {
  schema_version: typeof AGENT_UI_EVENT_SCHEMA_VERSION;
  event_id: string;
  event_type: string;
  chat_id: string;
  message_id: string;
  turn_id: string;
  parent_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type AgentUiState = {
  browserFrame: AgentUiBrowserFrame | null;
  browserBridgeAvailable: boolean;
  forms: Map<string, AgentUiForm>;
  errors: { message: string; path: string; timestamp: string }[];
};

export function createAgentUiEventState(): AgentUiState {
  return {
    browserFrame: null,
    browserBridgeAvailable: false,
    forms: new Map(),
    errors: [],
  };
}

export function normalizeAgentUiEvents(frame: unknown): AgentUiEvent[] {
  if (!isRecord(frame)) {
    return [];
  }
  const event = stringValue(frame.event);
  if (event === "agent_ui_event" || event === "agent_ui_form" || event === "form_request") {
    return normalizeNativeAgentUiFrame(frame);
  }
  if (event === "browser_frame" || event === "browser_snapshot") {
    return [
      createAgentUiEventEnvelope(frame, AGENT_UI_EVENT_TYPES["browser.frame.updated"], {
        image_url: stringValue(frame.image_url ?? frame.url ?? frame.image),
        command: stringValue(frame.command ?? frame.source_command),
        captured_at: stringValue(frame.captured_at ?? frame.timestamp),
      }),
    ];
  }
  if (event === "error" && stringValue(frame.chat_id)) {
    return [
      createAgentUiEventEnvelope(frame, AGENT_UI_EVENT_TYPES["error.raised"], {
        message: stringValue(frame.message),
        path: stringValue(frame.path),
      }),
    ];
  }
  return [];
}

export function reduceAgentUiEventState(state: AgentUiState, event: AgentUiEvent): AgentUiState {
  if (event.schema_version !== AGENT_UI_EVENT_SCHEMA_VERSION) {
    return state;
  }
  switch (event.event_type) {
    case AGENT_UI_EVENT_TYPES["browser.frame.updated"]:
      state.browserFrame = {
        image_url: stringValue(event.payload.image_url),
        command: stringValue(event.payload.command),
        captured_at: stringValue(event.payload.captured_at),
      };
      state.browserBridgeAvailable = Boolean(state.browserFrame.image_url);
      return state;
    case AGENT_UI_EVENT_TYPES["ui.form.requested"]:
      return reduceFormEventState(state, event, AGENT_UI_FORM_STATUSES.pending);
    case AGENT_UI_EVENT_TYPES["ui.form.updated"]:
      return reduceFormEventState(state, event, formStatus(event.payload.status) ?? AGENT_UI_FORM_STATUSES.pending);
    case AGENT_UI_EVENT_TYPES["ui.form.submitted"]:
      return reduceFormEventState(state, event, AGENT_UI_FORM_STATUSES.submitted);
    case AGENT_UI_EVENT_TYPES["ui.form.cancelled"]:
      return reduceFormEventState(state, event, AGENT_UI_FORM_STATUSES.cancelled);
    case AGENT_UI_EVENT_TYPES["ui.form.expired"]:
      return reduceFormEventState(state, event, AGENT_UI_FORM_STATUSES.expired);
    case AGENT_UI_EVENT_TYPES["ui.form.validation_failed"]:
      return reduceFormEventState(state, event, AGENT_UI_FORM_STATUSES.validationFailed);
    case AGENT_UI_EVENT_TYPES["error.raised"]:
      state.errors.push({
        message: stringValue(event.payload.message),
        path: stringValue(event.payload.path),
        timestamp: event.timestamp,
      });
      return state;
    default:
      return state;
  }
}

export function validateAgentUiFormValues(form: AgentUiForm, values: Record<string, unknown> = {}) {
  for (const field of form.fields) {
    validateValueAgainstField(field, values[field.name], `values.${field.name}`);
  }
  return values;
}

export function isAgentUiFormSubmittable(form: AgentUiForm | undefined): form is AgentUiForm {
  if (!form || form.submitting === true) {
    return false;
  }
  return (
    form.status !== AGENT_UI_FORM_STATUSES.submitted &&
    form.status !== AGENT_UI_FORM_STATUSES.cancelled &&
    form.status !== AGENT_UI_FORM_STATUSES.expired
  );
}

export function buildAgentUiFormSubmitRequest(form: AgentUiForm, values: Record<string, unknown> = {}) {
  if (!isAgentUiFormSubmittable(form)) {
    return null;
  }
  return {
    values: { ...values },
    correlation: { ...form.correlation },
  };
}

export function buildAgentUiFormCancelRequest(form: AgentUiForm) {
  if (!isAgentUiFormSubmittable(form)) {
    return null;
  }
  return {
    correlation: { ...form.correlation },
  };
}

function normalizeNativeAgentUiFrame(frame: Record<string, unknown>): AgentUiEvent[] {
  const source = isRecord(frame.agent_ui_event) ? frame.agent_ui_event : frame;
  const eventType = stringValue(source.event_type ?? source.type) || AGENT_UI_EVENT_TYPES["ui.form.requested"];
  try {
    const payload = normalizeAgentUiPayload(eventType, isRecord(source.payload) ? source.payload : formPayloadFromLegacyFrame(frame));
    const correlation = isRecord(payload.correlation) ? payload.correlation : {};
    return [
      {
        schema_version: AGENT_UI_EVENT_SCHEMA_VERSION,
        event_id: stringValue(source.event_id) || fallbackEventId(),
        event_type: eventType,
        chat_id: stringValue(source.chat_id ?? frame.chat_id ?? correlation.chat_id),
        message_id: stringValue(source.message_id ?? correlation.message_id),
        turn_id: stringValue(source.turn_id ?? correlation.turn_id),
        parent_id: stringValue(source.parent_id ?? correlation.parent_id),
        timestamp: stringValue(source.timestamp ?? frame.timestamp) || new Date().toISOString(),
        payload,
        metadata: {
          ...(isRecord(source.metadata) ? source.metadata : {}),
          source_frame: stringValue(frame.event) || "agent_ui_event",
          compatibility: "native-agent-ui-event",
        },
      },
    ];
  } catch (error) {
    return [
      createAgentUiEventEnvelope(frame, AGENT_UI_EVENT_TYPES["error.raised"], {
        message: error instanceof Error ? error.message : "Agent UI event normalization failed.",
        source_event: stringValue(frame.event),
      }),
    ];
  }
}

function normalizeAgentUiPayload(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  assertJsonSafe(payload);
  assertNoUnsafeFormSchemaKeys(payload);
  if (eventType === AGENT_UI_EVENT_TYPES["ui.form.requested"]) {
    return validateAgentUiFormRequestPayload(payload) as unknown as Record<string, unknown>;
  }
  const formId = normalizeRequiredString(payload.form_id, "form_id", 128);
  if (!FORM_ID_RE.test(formId)) {
    throw new TypeError("Agent UI form form_id is unsafe.");
  }
  return {
    ...payload,
    form_id: formId,
    correlation: isRecord(payload.correlation)
      ? { ...payload.correlation, form_id: payload.correlation.form_id || formId }
      : { form_id: formId },
  };
}

function validateAgentUiFormRequestPayload(payload: Record<string, unknown>): AgentUiForm {
  const formId = normalizeRequiredString(payload.form_id, "form_id", 128);
  if (!FORM_ID_RE.test(formId)) {
    throw new TypeError("Agent UI form form_id is unsafe.");
  }
  if (!Array.isArray(payload.fields) || payload.fields.length === 0 || payload.fields.length > MAX_FORM_FIELDS) {
    throw new TypeError("Agent UI form fields must be a bounded non-empty array.");
  }
  if (!isRecord(payload.correlation)) {
    throw new TypeError("Agent UI form correlation is required.");
  }
  const fields = payload.fields.map(normalizeFormField);
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new TypeError(`Agent UI form field name is duplicated: ${field.name}`);
    }
    names.add(field.name);
  }
  const normalized: AgentUiForm = {
    form_id: formId,
    title: normalizeRequiredString(payload.title, "title", 256),
    fields,
    correlation: { ...payload.correlation, form_id: payload.correlation.form_id || formId },
  };
  for (const key of ["description", "submit_label", "cancel_label"] as const) {
    const value = normalizeOptionalString(payload[key], key, 1024);
    if (value) {
      normalized[key] = value;
    }
  }
  const expiresAt = normalizeOptionalString(payload.expires_at, "expires_at", 128);
  if (expiresAt) {
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new TypeError("Agent UI form expires_at must be an ISO timestamp.");
    }
    normalized.expires_at = expiresAt;
  }
  if (isRecord(payload.initial_values)) {
    validateAgentUiFormValues(normalized, payload.initial_values);
    normalized.initial_values = { ...payload.initial_values };
  }
  return normalized;
}

function reduceFormEventState(state: AgentUiState, event: AgentUiEvent, status: AgentUiFormStatus): AgentUiState {
  const formId = stringValue(event.payload.form_id);
  if (!formId) {
    return state;
  }
  const existing = state.forms.get(formId);
  const next: AgentUiForm = {
    ...(existing ?? { form_id: formId, title: "", fields: [], correlation: {} }),
    form_id: formId,
    status,
    updated_at: event.timestamp,
    chat_id: event.chat_id || existing?.chat_id || "",
    message_id: event.message_id || existing?.message_id || "",
    turn_id: event.turn_id || existing?.turn_id || "",
    correlation: isRecord(event.payload.correlation)
      ? { ...(existing?.correlation ?? {}), ...event.payload.correlation, form_id: formId }
      : { ...(existing?.correlation ?? {}), form_id: formId },
    values: isRecord(event.payload.values) ? { ...event.payload.values } : existing?.values ?? {},
    errors: {},
    submitting: false,
  };
  if (event.event_type === AGENT_UI_EVENT_TYPES["ui.form.requested"]) {
    next.title = stringValue(event.payload.title);
    next.description = stringValue(event.payload.description);
    next.fields = Array.isArray(event.payload.fields) ? (event.payload.fields as AgentUiFormField[]) : [];
    next.submit_label = stringValue(event.payload.submit_label);
    next.cancel_label = stringValue(event.payload.cancel_label);
    next.expires_at = stringValue(event.payload.expires_at);
    next.values = isRecord(event.payload.initial_values) ? { ...event.payload.initial_values } : {};
  }
  if (event.event_type === AGENT_UI_EVENT_TYPES["ui.form.validation_failed"]) {
    next.errors = isRecord(event.payload.errors) ? stringifyRecord(event.payload.errors) : {};
  }
  state.forms.set(formId, next);
  return state;
}

function normalizeFormField(field: unknown, index: number): AgentUiFormField {
  if (!isRecord(field)) {
    throw new TypeError(`Agent UI form fields[${index}] must be an object.`);
  }
  const path = `fields[${index}]`;
  const name = normalizeRequiredString(field.name, `${path}.name`, 64);
  if (!FIELD_NAME_RE.test(name) || RESERVED_FIELD_NAMES.has(name)) {
    throw new TypeError(`Agent UI form ${path} has an unsafe field name.`);
  }
  const type = normalizeRequiredString(field.type, `${path}.type`, 64);
  if (!FIELD_TYPES.has(type)) {
    throw new TypeError(`Agent UI form ${path}.type is unsupported.`);
  }
  const normalized: AgentUiFormField = {
    name,
    type,
    label: normalizeRequiredString(field.label, `${path}.label`, 256),
    required: field.required === true,
  };
  for (const key of ["placeholder", "help"] as const) {
    const value = normalizeOptionalString(field[key], `${path}.${key}`, 512);
    if (value) {
      normalized[key] = value;
    }
  }
  for (const key of ["min", "max", "min_length", "max_length"] as const) {
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
  }
  if (field.default !== undefined) {
    validateValueAgainstField(normalized, field.default, `${path}.default`);
    normalized.default = field.default;
  }
  return normalized;
}

function validateValueAgainstField(field: AgentUiFormField, value: unknown, path: string) {
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
    const values = new Set((field.options ?? []).map((option) => option.value));
    for (const item of value) {
      if (!values.has(item as string | number | boolean)) {
        throw new TypeError(`Agent UI form ${path} contains an unsupported option.`);
      }
    }
    return;
  }
  if (CHOICE_FIELD_TYPES.has(field.type)) {
    const values = new Set((field.options ?? []).map((option) => option.value));
    if (!values.has(value as string | number | boolean)) {
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
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      throw new TypeError(`Agent UI form ${path} does not match the required pattern.`);
    }
  }
}

function createAgentUiEventEnvelope(frame: Record<string, unknown>, eventType: string, payload: Record<string, unknown>): AgentUiEvent {
  return {
    schema_version: AGENT_UI_EVENT_SCHEMA_VERSION,
    event_id: fallbackEventId(),
    event_type: eventType,
    chat_id: stringValue(frame.chat_id),
    message_id: stringValue(frame.message_id),
    turn_id: stringValue(frame.turn_id),
    parent_id: stringValue(frame.parent_id),
    timestamp: stringValue(frame.timestamp ?? frame.created_at) || new Date().toISOString(),
    payload,
    metadata: {
      source_frame: stringValue(frame.event),
      compatibility: "legacy-websocket-frame",
    },
  };
}

function formPayloadFromLegacyFrame(frame: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(frame.form)) {
    return frame.form;
  }
  if (isRecord(frame.payload)) {
    return frame.payload;
  }
  return frame;
}

function assertJsonSafe(value: unknown, path = "payload") {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Agent UI event ${path} must be JSON-safe.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
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

function assertNoUnsafeFormSchemaKeys(value: unknown, path = "form") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeFormSchemaKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_FORM_SCHEMA_KEYS.has(key)) {
      throw new TypeError(`Agent UI form schema rejected unsafe key: ${path}.${key}`);
    }
    assertNoUnsafeFormSchemaKeys(item, `${path}.${key}`);
  }
}

function normalizeFormOption(option: unknown, path: string) {
  if (!isRecord(option)) {
    throw new TypeError(`Agent UI form ${path} must be an object.`);
  }
  const value = option.value;
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new TypeError(`Agent UI form ${path}.value must be a string, number, or boolean.`);
  }
  return {
    label: normalizeRequiredString(option.label, `${path}.label`, 256),
    value: value as string | number | boolean,
  };
}

function normalizeOptionalString(value: unknown, path: string, maxLength: number): string {
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

function normalizeRequiredString(value: unknown, path: string, maxLength: number): string {
  const normalized = normalizeOptionalString(value, path, maxLength);
  if (!normalized) {
    throw new TypeError(`Agent UI form ${path} is required.`);
  }
  return normalized;
}

function formStatus(value: unknown): AgentUiFormStatus | null {
  return Object.values(AGENT_UI_FORM_STATUSES).includes(value as AgentUiFormStatus)
    ? (value as AgentUiFormStatus)
    : null;
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function fallbackEventId(): string {
  return `aui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
