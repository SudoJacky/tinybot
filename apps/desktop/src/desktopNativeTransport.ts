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

export type NativeTransportApi = {
  gatewayFrame(request: NativeTransportGatewayFrameRequest): Promise<unknown>;
};

export function createDesktopNativeTransportApi(options: { invoke?: TauriInvoke } = {}): NativeTransportApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    gatewayFrame: (request) => invoke("worker_transport_gateway_frame", { input: request }),
  };
}
