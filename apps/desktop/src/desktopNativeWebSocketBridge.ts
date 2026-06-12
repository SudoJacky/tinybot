import type { NativeTransportApi, NativeTransportWebSocketDispatchRequest } from "./desktopNativeTransport";

export type DesktopNativeWebSocketOptions = {
  url: string | URL;
  protocols?: string | string[];
  nativeTransport: NativeTransportApi;
  clientId?: string;
  editablePaths?: string[];
};

type Listener = (event: Event) => void;

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
  private attachedChatId?: string;

  constructor(options: DesktopNativeWebSocketOptions) {
    super();
    this.url = String(options.url);
    this.nativeTransport = options.nativeTransport;
    this.clientId = options.clientId ?? createClientId();
    this.editablePaths = options.editablePaths ?? ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "memory/MEMORY.md"];
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
    const finalContent = stringValue(agent?.finalContent);
    const chatId = stringValue(transport.chatId);
    if (finalContent && chatId) {
      this.emitJson({
        event: "message",
        chat_id: chatId,
        message_id: stringValue(agent?.runId) || `native:${chatId}`,
        text: finalContent,
      });
      this.emitJson({
        event: "stream_end",
        chat_id: chatId,
        message_id: stringValue(agent?.runId) || `native:${chatId}`,
        reason: stringValue(agent?.stopReason) || "stop",
      });
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
