import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeHostCommandDispatchRequest = {
  clientId: string;
  frame: Record<string, unknown>;
  attachedChatId: string;
};

export type NativeHostCommandApi = {
  dispatch(request: NativeHostCommandDispatchRequest): Promise<unknown>;
};

export function createDesktopNativeHostCommandApi(options: { invoke?: TauriInvoke } = {}): NativeHostCommandApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    dispatch: (request) => invoke("worker_dispatch_tinyos_host_command", { input: request }),
  };
}
