import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeTransportGatewayFrameRequest = {
  kind: "message" | "delta" | "usage";
  chatId: string;
  content?: string;
  delta?: string;
  usage?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type NativeTransportWebSocketMessageRequest = {
  clientId: string;
  frame: Record<string, unknown>;
  attachedChatId?: string;
  sessionExists?: boolean;
  editablePaths?: string[];
};

export type NativeTransportWebSocketDispatchRequest = NativeTransportWebSocketMessageRequest & {
  model?: string;
  maxIterations?: number;
  stream?: boolean;
};

export type NativeChannelInboundMessage = Record<string, unknown> & {
  channel: string;
  content: string;
  senderId?: string;
  sender_id?: string;
  chatId?: string;
  chat_id?: string;
  timestamp?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
  sessionKeyOverride?: string | null;
  session_key_override?: string | null;
  sessionKey?: string;
  session_key?: string;
};

export type NativeChannelDispatchInboundRequest = {
  message: NativeChannelInboundMessage;
};

export type NativeTransportApi = {
  gatewayFrame(request: NativeTransportGatewayFrameRequest): Promise<unknown>;
  websocketMessage(request: NativeTransportWebSocketMessageRequest): Promise<unknown>;
  dispatchWebsocketMessage(request: NativeTransportWebSocketDispatchRequest): Promise<unknown>;
  dispatchChannelInbound(request: NativeChannelDispatchInboundRequest): Promise<unknown>;
  startChannels(): Promise<unknown>;
  channelStatus(): Promise<unknown>;
  stopChannels(): Promise<unknown>;
};

export function createDesktopNativeTransportApi(options: { invoke?: TauriInvoke } = {}): NativeTransportApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    gatewayFrame: (request) => invoke("worker_transport_gateway_frame", { input: request }),
    websocketMessage: (request) => invoke("worker_transport_websocket_message", { input: request }),
    dispatchWebsocketMessage: (request) => invoke("worker_transport_dispatch_websocket_message", { input: request }),
    dispatchChannelInbound: (request) => invoke("worker_channel_dispatch_inbound", { input: request }),
    startChannels: () => invoke("worker_channel_start"),
    channelStatus: () => invoke("worker_channel_status"),
    stopChannels: () => invoke("worker_channel_stop"),
  };
}
