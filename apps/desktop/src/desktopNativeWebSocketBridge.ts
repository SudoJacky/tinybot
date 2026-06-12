import type { NativeTransportApi, NativeTransportWebSocketDispatchRequest } from "./desktopNativeTransport";

export type DesktopNativeWebSocketOptions = {
  url: string | URL;
  protocols?: string | string[];
  nativeTransport: NativeTransportApi;
  clientId?: string;
  editablePaths?: string[];
  listenToAgentEvent?: DesktopNativeWebSocketAgentEventListener;
};

type Listener = (event: Event) => void;
export type DesktopNativeWebSocketAgentEventName =
  | "agent.delta"
  | "agent.reasoning_delta"
  | "agent.tool_call.delta"
  | "agent.tool.start"
  | "agent.tool.result"
  | "agent.usage"
  | "agent.awaiting_form"
  | "agent.awaiting_approval"
  | "agent.memory_reference"
  | "agent.task_progress"
  | "agent.browser_frame"
  | "agent.cancelled"
  | "agent.done"
  | "agent.error";
export type DesktopNativeWebSocketAgentEventHandler = (payload: unknown) => void;
export type DesktopNativeWebSocketAgentEventListener = (
  eventName: DesktopNativeWebSocketAgentEventName,
  handler: DesktopNativeWebSocketAgentEventHandler,
) => Promise<() => void> | (() => void) | void;

const AGENT_EVENT_NAMES: DesktopNativeWebSocketAgentEventName[] = [
  "agent.delta",
  "agent.reasoning_delta",
  "agent.tool_call.delta",
  "agent.tool.start",
  "agent.tool.result",
  "agent.usage",
  "agent.awaiting_form",
  "agent.awaiting_approval",
  "agent.memory_reference",
  "agent.task_progress",
  "agent.browser_frame",
  "agent.cancelled",
  "agent.done",
  "agent.error",
];

type ActiveRun = {
  chatId: string;
  sessionId?: string;
  messageId: string;
  streamed: boolean;
};

type ActiveToolCallDelta = {
  argumentsText: string;
  toolCallId: string;
  toolName: string;
};

export function createDesktopNativeWebSocket(options: DesktopNativeWebSocketOptions): WebSocket {
  return new DesktopNativeWebSocket(options) as unknown as WebSocket;
}

class DesktopNativeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState = DesktopNativeWebSocket.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  private readonly nativeTransport: NativeTransportApi;
  private readonly clientId: string;
  private readonly editablePaths?: string[];
  private readonly listenToAgentEvent?: DesktopNativeWebSocketAgentEventListener;
  private readonly agentEventUnlisteners: Array<() => void> = [];
  private readonly pendingAgentEvents = new Map<string, Array<{ eventName: DesktopNativeWebSocketAgentEventName; payload: Record<string, unknown> }>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeToolCallDeltas = new Map<string, ActiveToolCallDelta>();
  private readonly completedStreamedRunIds = new Set<string>();
  private attachedChatId?: string;

  constructor(options: DesktopNativeWebSocketOptions) {
    super();
    this.url = String(options.url);
    this.nativeTransport = options.nativeTransport;
    this.clientId = options.clientId ?? createClientId();
    this.editablePaths = options.editablePaths ?? ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "memory/MEMORY.md"];
    this.listenToAgentEvent = options.listenToAgentEvent;
    this.registerAgentEventListeners();
    queueMicrotask(() => {
      if (this.readyState !== DesktopNativeWebSocket.CONNECTING) {
        return;
      }
      this.readyState = DesktopNativeWebSocket.OPEN;
      this.emit("open", new Event("open"));
      this.emitJson({ event: "ready", client_id: this.clientId });
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== DesktopNativeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    if (typeof data !== "string") {
      this.emitJson({ event: "error", message: "unsupported websocket payload" });
      return;
    }
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      frame = isRecord(parsed) ? parsed : {};
    } catch {
      this.emitJson({ event: "error", message: "invalid json" });
      return;
    }

    const request: NativeTransportWebSocketDispatchRequest = {
      clientId: this.clientId,
      frame,
      ...(this.attachedChatId ? { attachedChatId: this.attachedChatId } : {}),
      ...(this.editablePaths ? { editablePaths: this.editablePaths } : {}),
    };
    void this.nativeTransport.dispatchWebsocketMessage(request)
      .then((result) => this.applyDispatchResult(result))
      .catch((error) => {
        this.emitJson({ event: "error", message: error instanceof Error ? error.message : String(error) });
      });
  }

  close(): void {
    if (this.readyState === DesktopNativeWebSocket.CLOSED) {
      return;
    }
    this.readyState = DesktopNativeWebSocket.CLOSED;
    this.unlistenAgentEvents();
    this.emit("close", new Event("close"));
  }

  private applyDispatchResult(result: unknown): void {
    const payload = isRecord(result) ? result : {};
    const transport = isRecord(payload.transport) ? payload.transport : payload;
    const attachedChatId = stringValue(transport.attachedChatId);
    if (attachedChatId) {
      this.attachedChatId = attachedChatId;
    }
    for (const frame of arrayValue(transport.frames)) {
      if (isRecord(frame)) {
        this.emitJson(frame);
      }
    }
    const agent = isRecord(payload.agent) ? payload.agent : undefined;
    const runId = stringValue(agent?.runId) || stringValue(agent?.run_id);
    const chatId = stringValue(transport.chatId) || stringValue(transport.chat_id);
    if (runId && chatId) {
      this.registerRun(runId, {
        chatId,
        sessionId: stringValue(transport.sessionId) || stringValue(transport.session_id),
        messageId: stringValue(agent?.messageId) || stringValue(agent?.message_id) || runId,
        streamed: false,
      });
    }
    const finalContent = stringValue(agent?.finalContent);
    const run = runId ? this.activeRuns.get(runId) : undefined;
    const alreadyProjectedStream = Boolean((runId && this.completedStreamedRunIds.has(runId)) || run?.streamed);
    if (finalContent && chatId && !alreadyProjectedStream) {
      this.emitJson({
        event: "message",
        chat_id: chatId,
        message_id: runId || `native:${chatId}`,
        text: finalContent,
      });
      this.emitJson({
        event: "stream_end",
        chat_id: chatId,
        message_id: runId || `native:${chatId}`,
        reason: stringValue(agent?.stopReason) || "stop",
      });
    }
  }

  private registerAgentEventListeners(): void {
    if (!this.listenToAgentEvent) {
      return;
    }
    for (const eventName of AGENT_EVENT_NAMES) {
      const unlisten = this.listenToAgentEvent(eventName, (payload) => {
        this.handleAgentEvent(eventName, payload);
      });
      if (typeof unlisten === "function") {
        this.agentEventUnlisteners.push(unlisten);
        continue;
      }
      if (unlisten && typeof (unlisten as Promise<() => void>).then === "function") {
        void (unlisten as Promise<() => void>).then((resolvedUnlisten) => {
          if (this.readyState === DesktopNativeWebSocket.CLOSED) {
            resolvedUnlisten();
          } else {
            this.agentEventUnlisteners.push(resolvedUnlisten);
          }
        });
      }
    }
  }

  private unlistenAgentEvents(): void {
    while (this.agentEventUnlisteners.length > 0) {
      const unlisten = this.agentEventUnlisteners.pop();
      unlisten?.();
    }
    this.pendingAgentEvents.clear();
    this.activeRuns.clear();
    this.activeToolCallDeltas.clear();
    this.completedStreamedRunIds.clear();
  }

  private registerRun(runId: string, run: ActiveRun): void {
    const existing = this.activeRuns.get(runId);
    this.activeRuns.set(runId, existing ? { ...run, messageId: existing.messageId, streamed: existing.streamed } : run);
    const pending = this.pendingAgentEvents.get(runId) ?? [];
    this.pendingAgentEvents.delete(runId);
    for (const event of pending) {
      this.projectAgentEvent(event.eventName, event.payload, runId);
    }
  }

  private handleAgentEvent(eventName: DesktopNativeWebSocketAgentEventName, payload: unknown): void {
    if (this.readyState === DesktopNativeWebSocket.CLOSED) {
      return;
    }
    const record = isRecord(payload) ? payload : {};
    const runId = stringValue(record.runId) || stringValue(record.run_id);
    if (!runId) {
      return;
    }
    if (!this.activeRuns.has(runId)) {
      const events = this.pendingAgentEvents.get(runId) ?? [];
      events.push({ eventName, payload: record });
      this.pendingAgentEvents.set(runId, events);
      return;
    }
    this.projectAgentEvent(eventName, record, runId);
  }

  private projectAgentEvent(eventName: DesktopNativeWebSocketAgentEventName, payload: Record<string, unknown>, runId: string): void {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return;
    }
    const messageId = stringValue(payload.messageId) || stringValue(payload.message_id) || run.messageId;
    if (messageId) {
      run.messageId = messageId;
    }
    if (eventName === "agent.delta" || eventName === "agent.reasoning_delta") {
      const text = stringValue(payload.delta) || stringValue(payload.text) || stringValue(payload.content);
      if (!text) {
        return;
      }
      run.streamed = true;
      this.emitJson({
        event: "delta",
        chat_id: run.chatId,
        message_id: run.messageId,
        text,
        is_reasoning: eventName === "agent.reasoning_delta",
      });
      return;
    }
    if (eventName === "agent.tool_call.delta") {
      const index = numberValue(payload.index) ?? 0;
      const deltaKey = toolCallDeltaKey(runId, index);
      const current = this.activeToolCallDeltas.get(deltaKey);
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || current?.toolCallId || `${runId}:tool-${index}`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || current?.toolName || "tool";
      const argumentsText = `${current?.argumentsText ?? ""}${stringValue(payload.deltaText) || stringValue(payload.delta_text) || stringValue(payload.argumentsDelta) || stringValue(payload.arguments_delta)}`;
      this.activeToolCallDeltas.set(deltaKey, { argumentsText, toolCallId, toolName });
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:args`, toolName, toolCallId, formatToolCallText(toolName, argumentsText), {
        detail: true,
        hint: true,
      });
      return;
    }
    if (eventName === "agent.tool.start") {
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:tool`;
      const cachedToolCall = this.findToolCallDelta(runId, toolCallId);
      const toolName = cachedToolCall?.toolName || stringValue(payload.toolName) || stringValue(payload.tool_name) || "tool";
      const text = formatToolCallText(toolName, cachedToolCall?.argumentsText ?? "");
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:start`, toolName, toolCallId, text, {
        detail: true,
        hint: true,
      });
      return;
    }
    if (eventName === "agent.tool.result") {
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:tool`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || "tool";
      const text = stringValue(payload.content) || stringValue(payload.result) || stringValue(payload.output);
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:result`, toolName, toolCallId, text, {
        result: true,
      });
      this.deleteToolCallDelta(runId, toolCallId);
      return;
    }
    if (eventName === "agent.usage") {
      this.emitJson({
        event: "usage",
        chat_id: run.chatId,
        usage: isRecord(payload.usage) ? payload.usage : payload,
      });
      return;
    }
    if (eventName === "agent.awaiting_form") {
      this.emitAwaitingFormFrame(run, payload, runId);
      return;
    }
    if (eventName === "agent.awaiting_approval") {
      const approvalId = stringValue(payload.approvalId) || stringValue(payload.approval_id);
      this.emitJson({
        event: "approval_pending",
        chat_id: run.chatId,
        ...(approvalId ? { approval_id: approvalId } : {}),
      });
      return;
    }
    if (eventName === "agent.memory_reference") {
      const references = arrayValue(payload.references);
      if (references.length === 0) {
        return;
      }
      this.emitJson({
        event: "message",
        chat_id: run.chatId,
        message_id: run.messageId,
        text: "",
        _memory_references: references,
      });
      return;
    }
    if (eventName === "agent.task_progress") {
      const progress = payload.progress ?? payload.taskProgress ?? payload.task_progress;
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:task-progress`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || "task_progress";
      const planId = stringValue(payload.planId) || stringValue(payload.plan_id) || (isRecord(progress) ? stringValue(progress.plan_id) : "");
      this.emitTaskProgressFrame(run.chatId, `${runId}:${toolCallId}:task-progress`, toolName, toolCallId, progress, planId);
      return;
    }
    if (eventName === "agent.browser_frame") {
      this.emitJson({
        event: "browser_frame",
        chat_id: run.chatId,
        image_url: stringValue(payload.imageUrl) || stringValue(payload.image_url),
        source_command: stringValue(payload.sourceCommand) || stringValue(payload.source_command),
        captured_at: payload.capturedAt ?? payload.captured_at ?? null,
      });
      return;
    }
    if (eventName === "agent.cancelled") {
      run.streamed = true;
      this.emitJson({
        event: "interrupted",
        chat_id: run.chatId,
        cancelled: payload.cancelled !== false,
      });
      this.activeRuns.delete(runId);
      this.completedStreamedRunIds.add(runId);
      this.clearToolCallDeltas(runId);
      return;
    }
    if (eventName === "agent.error") {
      run.streamed = true;
      this.emitJson({
        event: "error",
        chat_id: run.chatId,
        message_id: run.messageId,
        message: stringValue(payload.message) || stringValue(payload.error) || "agent error",
      });
      return;
    }
    if (eventName === "agent.done") {
      run.streamed = true;
      this.emitJson({
        event: "stream_end",
        chat_id: run.chatId,
        message_id: run.messageId,
        reason: stringValue(payload.stopReason) || stringValue(payload.stop_reason) || "stop",
        ...referenceMetadata(payload),
      });
      this.activeRuns.delete(runId);
      this.completedStreamedRunIds.add(runId);
      this.clearToolCallDeltas(runId);
    }
  }

  private emitAwaitingFormFrame(run: ActiveRun, payload: Record<string, unknown>, runId: string): void {
    const form = isRecord(payload.form) ? payload.form : {};
    const formId = stringValue(payload.formId) || stringValue(payload.form_id) || stringValue(form.form_id);
    if (!formId) {
      return;
    }
    const correlation = isRecord(form.correlation) ? form.correlation : {};
    const agentUiPayload = {
      ...form,
      form_id: formId,
      correlation: {
        ...correlation,
        chat_id: stringValue(correlation.chat_id) || run.chatId,
        form_id: stringValue(correlation.form_id) || formId,
        run_id: stringValue(correlation.run_id) || runId,
        ...(stringValue(correlation.session_id) || run.sessionId
          ? { session_id: stringValue(correlation.session_id) || run.sessionId }
          : {}),
      },
    };
    this.emitJson({
      event: "agent_ui_event",
      chat_id: run.chatId,
      agent_ui_event: {
        event_type: "ui.form.requested",
        chat_id: run.chatId,
        payload: agentUiPayload,
      },
    });
  }

  private emitTaskProgressFrame(
    chatId: string,
    messageId: string,
    toolName: string,
    toolCallId: string,
    progress: unknown,
    planId: string,
  ): void {
    this.emitJson({
      event: "message",
      chat_id: chatId,
      message_id: messageId,
      text: "Task progress updated.",
      _progress: true,
      _tool_call_id: toolCallId,
      _tool_name: toolName,
      _tool_result: true,
      _task_event: true,
      ...(planId ? { _task_plan_id: planId } : {}),
      _task_progress: progress,
    });
  }

  private emitToolProgressFrame(
    chatId: string,
    messageId: string,
    toolName: string,
    toolCallId: string,
    text: string,
    flags: { detail?: boolean; hint?: boolean; result?: boolean },
  ): void {
    this.emitJson({
      event: "message",
      chat_id: chatId,
      message_id: messageId,
      text,
      _progress: true,
      _tool_call_id: toolCallId,
      ...(flags.detail ? { _tool_detail: true } : {}),
      ...(flags.hint ? { _tool_hint: true } : {}),
      ...(flags.result ? { _tool_result: true } : {}),
      _tool_name: toolName,
    });
  }

  private findToolCallDelta(runId: string, toolCallId: string): ActiveToolCallDelta | null {
    for (const [key, value] of this.activeToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        return value;
      }
    }
    return null;
  }

  private deleteToolCallDelta(runId: string, toolCallId: string): void {
    for (const [key, value] of this.activeToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        this.activeToolCallDeltas.delete(key);
      }
    }
  }

  private clearToolCallDeltas(runId: string): void {
    for (const key of this.activeToolCallDeltas.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.activeToolCallDeltas.delete(key);
      }
    }
  }

  private emitJson(payload: Record<string, unknown>): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  private emit(type: "open" | "message" | "error" | "close", event: Event): void {
    this.dispatchEvent(event);
    const handler = this[`on${type}`];
    if (handler) {
      handler.call(this, event);
    }
  }
}

function createClientId(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function referenceMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const memoryReferences = arrayValue(payload._memory_references ?? payload.memoryReferences ?? payload.memory_references);
  const recentContextReferences = arrayValue(
    payload._recent_context_references ?? payload.recentContextReferences ?? payload.recent_context_references,
  );
  return {
    ...(memoryReferences.length ? { _memory_references: memoryReferences } : {}),
    ...(recentContextReferences.length ? { _recent_context_references: recentContextReferences } : {}),
  };
}

function toolCallDeltaKey(runId: string, index: number): string {
  return `${runId}:${index}`;
}

function formatToolCallText(toolName: string, argumentsText: string): string {
  return `${toolName}(${argumentsText})`;
}
