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
});

const AGENT_UI_RENDERER_SURFACE_VALUES = new Set(Object.values(AGENT_UI_RENDERER_SURFACES));

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
        command: frame.command || "",
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
  if (frame.event === "chat_created" || frame.event === "attached" || frame.event === "cowork_updated") {
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
