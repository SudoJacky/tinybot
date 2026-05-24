import { AGENT_UI_EVENT_TYPES } from "./agent-ui-events.js";

export const LEGACY_AGENT_UI_FRAME_FIXTURES = Object.freeze([
  {
    name: "chat created starts pending user message flow",
    frame: { event: "chat_created", chat_id: "chat-1" },
    visibleBehavior: "Activates the created chat, refreshes sessions, and sends the pending message when present.",
    normalizedEvents: [],
  },
  {
    name: "attached reloads persisted messages",
    frame: { event: "attached", chat_id: "chat-1" },
    visibleBehavior: "Activates the attached chat and reloads persisted messages from the session route.",
    normalizedEvents: [],
  },
  {
    name: "assistant text delta",
    frame: { event: "delta", chat_id: "chat-1", message_id: "msg-1", text: "Hello", is_reasoning: false },
    visibleBehavior: "Appends text to the assistant streaming message.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["message.delta"]],
  },
  {
    name: "reasoning delta",
    frame: { event: "delta", chat_id: "chat-1", message_id: "msg-1", text: "Plan", is_reasoning: true },
    visibleBehavior: "Appends text to the collapsible reasoning area for the live message.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["reasoning.delta"]],
  },
  {
    name: "assistant message with references",
    frame: {
      event: "message",
      chat_id: "chat-1",
      message_id: "msg-2",
      text: "Final answer",
      _memory_references: [{ id: "mem-1", title: "Memory" }],
      _recent_context_references: [{ id: "ctx-1", title: "Recent context" }],
    },
    visibleBehavior: "Adds a completed assistant message and renders memory plus recent-context references.",
    normalizedEvents: [
      AGENT_UI_EVENT_TYPES["message.completed"],
      AGENT_UI_EVENT_TYPES["memory.references.updated"],
      AGENT_UI_EVENT_TYPES["recent_context.references.updated"],
    ],
  },
  {
    name: "tool progress message",
    frame: {
      event: "message",
      chat_id: "chat-1",
      text: "Running shell command",
      _progress: true,
      _tool_detail: true,
      _tool_name: "shell",
      _approval_id: "approval-1",
    },
    visibleBehavior: "Adds a temporary progress/tool card and refreshes approvals.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["tool.call.updated"]],
  },
  {
    name: "task progress message",
    frame: {
      event: "message",
      chat_id: "chat-1",
      message_id: "task-plan-1",
      text: "Task progress",
      _progress: true,
      _task_event: true,
      _task_progress: { plan_id: "plan-1", progress: { completed: 1, total: 3 } },
    },
    visibleBehavior: "Upserts the task progress card instead of adding a persisted chat message.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["tool.call.updated"]],
  },
  {
    name: "stream end with references",
    frame: {
      event: "stream_end",
      chat_id: "chat-1",
      message_id: "msg-1",
      _memory_references: [{ id: "mem-1" }],
      _recent_context_references: [{ id: "ctx-1" }],
    },
    visibleBehavior: "Finalizes the live stream, attaches references, rerenders, and refreshes approvals.",
    normalizedEvents: [
      AGENT_UI_EVENT_TYPES["message.stream.completed"],
      AGENT_UI_EVENT_TYPES["memory.references.updated"],
      AGENT_UI_EVENT_TYPES["recent_context.references.updated"],
    ],
  },
  {
    name: "approval pending",
    frame: { event: "approval_pending", chat_id: "chat-1", approval_id: "approval-1" },
    visibleBehavior: "Refreshes approval cards through the existing approval control route.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["approval.requested"]],
  },
  {
    name: "browser frame",
    frame: {
      event: "browser_frame",
      chat_id: "chat-1",
      url: "/browser/frame.png",
      command: "click",
      captured_at: "2026-05-24T00:00:00Z",
    },
    visibleBehavior: "Updates the browser panel with the latest frame.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["browser.frame.updated"]],
  },
  {
    name: "browser snapshot",
    frame: {
      event: "browser_snapshot",
      chat_id: "chat-1",
      image_url: "/browser/snapshot.png",
      command: "inspect",
      captured_at: "2026-05-24T00:00:01Z",
    },
    visibleBehavior: "Updates the browser panel with a captured snapshot.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["browser.frame.updated"]],
  },
  {
    name: "usage update",
    frame: {
      event: "usage",
      chat_id: "chat-1",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 },
    },
    visibleBehavior: "Updates the token usage status surface.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["usage.updated"]],
  },
  {
    name: "session file updated",
    frame: { event: "file_updated", chat_id: "chat-1", path: "notes.md" },
    visibleBehavior: "Reloads editable files and refreshes the active file if it has no local edits.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["session.file.updated"]],
  },
  {
    name: "error notice",
    frame: { event: "error", chat_id: "chat-1", message: "Server error", path: "notes.md" },
    visibleBehavior: "Shows the error in the global status and mirrors file errors to the editor.",
    normalizedEvents: [AGENT_UI_EVENT_TYPES["error.raised"]],
  },
  {
    name: "cowork compatibility refresh",
    frame: { event: "cowork_updated", session_id: "cowork-1" },
    visibleBehavior: "Schedules a Cowork snapshot refresh without Agent UI normalization.",
    normalizedEvents: [],
    compatibilityPassthrough: true,
  },
]);

export const AGENT_UI_FORM_REQUEST_FIXTURES = Object.freeze({
  validRequest: {
    form_id: "travel-preferences-1",
    title: "Travel preferences",
    description: "Collect itinerary constraints before planning.",
    submit_label: "Save preferences",
    cancel_label: "Skip",
    expires_at: "2026-05-24T12:00:00Z",
    correlation: {
      session_key: "websocket:chat-1",
      chat_id: "chat-1",
      run_id: "run-1",
      message_id: "msg-form-1",
    },
    initial_values: {
      destination: "Shanghai",
      nights: 3,
      hotel_required: true,
      interests: ["food"],
    },
    fields: [
      {
        name: "destination",
        type: "text",
        label: "Destination",
        required: true,
        placeholder: "City or region",
        min_length: 2,
        max_length: 80,
      },
      {
        name: "notes",
        type: "textarea",
        label: "Notes",
        help: "Dietary needs, schedule constraints, or anything else.",
        max_length: 500,
      },
      {
        name: "nights",
        type: "number",
        label: "Nights",
        required: true,
        min: 1,
        max: 30,
        default: 3,
      },
      {
        name: "style",
        type: "select",
        label: "Travel style",
        options: [
          { label: "Relaxed", value: "relaxed" },
          { label: "Packed", value: "packed" },
        ],
      },
      {
        name: "interests",
        type: "multiselect",
        label: "Interests",
        options: [
          { label: "Food", value: "food" },
          { label: "Museums", value: "museums" },
        ],
      },
      {
        name: "hotel_required",
        type: "checkbox",
        label: "Need hotel suggestions",
        default: true,
      },
      {
        name: "budget",
        type: "radio",
        label: "Budget",
        options: [
          { label: "Standard", value: "standard" },
          { label: "Premium", value: "premium" },
        ],
      },
      { name: "depart_on", type: "date", label: "Depart on" },
      { name: "wake_time", type: "time", label: "Preferred start time" },
      { name: "deadline", type: "datetime", label: "Decision deadline" },
      { name: "workspace_path", type: "file_path", label: "Workspace file" },
    ],
  },
  invalidSchemas: [
    {
      name: "unsafe html payload",
      payload: {
        form_id: "unsafe-1",
        title: "Unsafe",
        correlation: { chat_id: "chat-1" },
        fields: [{ name: "details", type: "text", label: "Details", html: "<script>alert(1)</script>" }],
      },
      error: /unsafe key|executable UI payload/i,
    },
    {
      name: "unsupported field type",
      payload: {
        form_id: "unsupported-1",
        title: "Unsupported",
        correlation: { chat_id: "chat-1" },
        fields: [{ name: "color", type: "color_picker", label: "Color" }],
      },
      error: /unsupported/i,
    },
    {
      name: "choice field without options",
      payload: {
        form_id: "missing-options-1",
        title: "Missing options",
        correlation: { chat_id: "chat-1" },
        fields: [{ name: "choice", type: "select", label: "Choice" }],
      },
      error: /options/i,
    },
    {
      name: "duplicate field names",
      payload: {
        form_id: "duplicate-1",
        title: "Duplicate",
        correlation: { chat_id: "chat-1" },
        fields: [
          { name: "value", type: "text", label: "Value" },
          { name: "value", type: "text", label: "Value again" },
        ],
      },
      error: /duplicated/i,
    },
  ],
  submitted: {
    form_id: "travel-preferences-1",
    status: "submitted",
    values: {
      destination: "Shanghai",
      nights: 3,
      hotel_required: true,
    },
    correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
  },
  cancelled: {
    form_id: "travel-preferences-1",
    status: "cancelled",
    correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
  },
  expired: {
    form_id: "travel-preferences-1",
    status: "expired",
    expired_at: "2026-05-24T12:00:01Z",
    correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
  },
  validationFailed: {
    form_id: "travel-preferences-1",
    status: "validation_failed",
    values: {
      destination: "",
      nights: 31,
    },
    errors: {
      destination: "Destination is required.",
      nights: "Nights must be 30 or less.",
    },
    correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
  },
  nativeFrames: [
    {
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.requested"],
        chat_id: "chat-1",
        message_id: "msg-form-1",
        run_id: "run-1",
        payload: {
          form_id: "travel-preferences-1",
          title: "Travel preferences",
          correlation: {
            chat_id: "chat-1",
            run_id: "run-1",
            message_id: "msg-form-1",
          },
          fields: [
            { name: "destination", type: "text", label: "Destination", required: true },
            { name: "nights", type: "number", label: "Nights", min: 1, max: 30 },
          ],
          initial_values: { destination: "Shanghai", nights: 3 },
        },
      },
    },
    {
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.validation_failed"],
        chat_id: "chat-1",
        payload: {
          form_id: "travel-preferences-1",
          values: { destination: "", nights: 31 },
          errors: { destination: "Destination is required." },
          correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
        },
      },
    },
    {
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.submitted"],
        chat_id: "chat-1",
        payload: {
          form_id: "travel-preferences-1",
          values: { destination: "Shanghai", nights: 3 },
          correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
        },
      },
    },
    {
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.cancelled"],
        chat_id: "chat-1",
        payload: {
          form_id: "travel-preferences-1",
          correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
        },
      },
    },
    {
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.expired"],
        chat_id: "chat-1",
        payload: {
          form_id: "travel-preferences-1",
          correlation: { chat_id: "chat-1", run_id: "run-1", message_id: "msg-form-1" },
        },
      },
    },
  ],
});
