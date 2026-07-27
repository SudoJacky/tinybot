import type { NativeBackendKind } from "../native/nativeBackendContract";

export type GatewayRuntimeStatus = {
  state: "running" | "starting" | "offline" | "failed";
  owner: "shell" | "external" | "none";
  command: string;
  repo_root: string;
  log_path?: string | null;
  log_tail?: string[];
  logs: string[];
  last_error: string | null;
  exit_policy?: "stop_on_exit" | "keep_running" | string | null;
  bootstrap_status?: "ready" | "offline" | "incompatible" | "bootstrap_error" | string | null;
  response_class?: string | null;
  recovery_hint?: string | null;
  worker_runtime?: DesktopWorkerRuntimeStatus | null;
};

export type DesktopWorkerRuntimeStatus = {
  state: "stopped" | "starting" | "running" | "failed" | "incompatible" | string;
  backend_kind?: NativeBackendKind | string;
  transport_mode?: "stdio" | "local_pipe" | string | null;
  diagnostics?: Array<{ stream: string; line: string }>;
  last_error?: string | null;
  recovery_hint?: string | null;
};

export const DEFAULT_NATIVE_BACKEND_COMMAND = "Tauri Rust backend";
