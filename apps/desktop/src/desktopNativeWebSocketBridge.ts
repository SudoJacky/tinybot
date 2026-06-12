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
  "agent.done",
  "agent.error",
];

type ActiveRun = {
  chatId: string;
  messageId: string;
  streamed: boolean;
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
    if (eventName === "agent.usage") {
      run.streamed = true;
      this.emitJson({
        event: "usage",
        chat_id: run.chatId,
        usage: isRecord(payload.usage) ? payload.usage : payload,
      });
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
      });
      this.activeRuns.delete(runId);
      this.completedStreamedRunIds.add(runId);
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
