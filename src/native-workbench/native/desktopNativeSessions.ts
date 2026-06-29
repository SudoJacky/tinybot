import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeSessionsApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeSessionsApi(options: { invoke?: TauriInvoke } = {}): NativeSessionsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_sessions_list"),
    messages: (key: string) => invoke("worker_session_messages", { input: { key } }),
  };
}
