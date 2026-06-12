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

export type NativeTransportApi = {
  gatewayFrame(request: NativeTransportGatewayFrameRequest): Promise<unknown>;
  websocketMessage(request: NativeTransportWebSocketMessageRequest): Promise<unknown>;
  dispatchWebsocketMessage(request: NativeTransportWebSocketDispatchRequest): Promise<unknown>;
};

export function createDesktopNativeTransportApi(options: { invoke?: TauriInvoke } = {}): NativeTransportApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    gatewayFrame: (request) => invoke("worker_transport_gateway_frame", { input: request }),
    websocketMessage: (request) => invoke("worker_transport_websocket_message", { input: request }),
    dispatchWebsocketMessage: (request) => invoke("worker_transport_dispatch_websocket_message", { input: request }),
  };
}
