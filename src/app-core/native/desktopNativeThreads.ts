import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeThreadStatus =
  | "empty"
  | "idle"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "cancelling"
  | "failed"
  | "archived";

export type NativeThreadRecord = {
  threadId: string;
  title: string;
  status: NativeThreadStatus;
  sessionKey?: string;
  activeRunId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  metadata?: {
    extra?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type NativeThreadListResult = {
  threads: NativeThreadRecord[];
  total: number;
  nextOffset?: number;
};

export type NativeThreadTurnInput = {
  threadId: string;
  input: {
    role: "user";
    content: string;
    clientEventId: string;
    references?: unknown[];
    attachments?: Array<{
      type: "text";
      name: string;
      mimeType: string;
      sizeBytes: number;
      content: string;
    }>;
  };
  spec: {
    runId: string;
    sessionId: string;
    stream: true;
    model?: string;
    metadata: Record<string, unknown>;
  };
};

export type NativeThreadTurnResult = {
  threadId: string;
  sessionId: string;
  runId: string;
  agentResult: unknown;
  snapshot: unknown;
};

export type NativeThreadApprovalInput = {
  threadId: string;
  approvalId: string;
  approved: boolean;
  scope?: "once" | "session";
  guidance?: string;
};

export type NativeThreadFormInput = {
  threadId: string;
  formId: string;
  values: Record<string, unknown>;
  action: "submit" | "cancel";
};

export type NativeThreadsApi = {
  create(body?: Record<string, unknown>): Promise<NativeThreadRecord>;
  read(body: Record<string, unknown>): Promise<unknown>;
  resume(body: Record<string, unknown>): Promise<unknown>;
  list(body?: Record<string, unknown>): Promise<NativeThreadListResult>;
  search(body: Record<string, unknown>): Promise<unknown>;
  activity(body: Record<string, unknown>): Promise<unknown>;
  status(body: Record<string, unknown>): Promise<unknown>;
  updateMetadata(body: Record<string, unknown>): Promise<NativeThreadRecord>;
  agentRegistry(body?: Record<string, unknown>): Promise<unknown>;
  startTurn(body: Record<string, unknown>): Promise<unknown>;
  continueTurn(body: Record<string, unknown>): Promise<unknown>;
  interrupt(body: { threadId: string; runId?: string; clientEventId?: string; reason?: string }): Promise<unknown>;
  applyOp(body: Record<string, unknown>): Promise<unknown>;
  archive(body: { threadId: string; archived?: boolean }): Promise<NativeThreadRecord>;
  unarchive(body: { threadId: string }): Promise<NativeThreadRecord>;
  delete(body: { threadId: string }): Promise<unknown>;
  fork(body: Record<string, unknown>): Promise<unknown>;
  events(body: Record<string, unknown>): Promise<unknown>;
  restoreCheckpoint(body: Record<string, unknown>): Promise<unknown>;
  submitTurn(body: NativeThreadTurnInput): Promise<NativeThreadTurnResult>;
  resolveApproval(body: NativeThreadApprovalInput): Promise<unknown>;
  submitForm(body: NativeThreadFormInput): Promise<unknown>;
};

export function createDesktopNativeThreadsApi(options: { invoke?: TauriInvoke } = {}): NativeThreadsApi {
  const invoke = options.invoke ?? tauriInvoke;
  const thread = <T>(command: string, body: unknown = {}) => invoke(command, { input: { body } }) as Promise<T>;
  return {
    create: (body) => thread<NativeThreadRecord>("worker_thread_create", body),
    read: (body) => thread("worker_thread_read", body),
    resume: (body) => thread("worker_thread_resume", body),
    list: (body) => thread<NativeThreadListResult>("worker_threads_list", body),
    search: (body) => thread("worker_thread_search", body),
    activity: (body) => thread("worker_thread_activity", body),
    status: (body) => thread("worker_thread_status", body),
    updateMetadata: (body) => thread<NativeThreadRecord>("worker_thread_update_metadata", body),
    agentRegistry: (body) => thread("worker_thread_agent_registry", body),
    startTurn: (body) => thread("worker_thread_start_turn", body),
    continueTurn: (body) => thread("worker_thread_continue_turn", body),
    interrupt: (body) => thread("worker_thread_interrupt", body),
    applyOp: (body) => thread("worker_thread_apply_op", body),
    archive: (body) => thread<NativeThreadRecord>("worker_thread_archive", body),
    unarchive: (body) => thread<NativeThreadRecord>("worker_thread_unarchive", body),
    delete: (body) => thread("worker_thread_delete", body),
    fork: (body) => thread("worker_thread_fork", body),
    events: (body) => thread("worker_thread_events", body),
    restoreCheckpoint: (body) => thread("worker_thread_restore_checkpoint", body),
    submitTurn: (body) => invoke("worker_submit_thread_turn", { input: body }) as Promise<NativeThreadTurnResult>,
    resolveApproval: (body) => invoke("worker_resolve_thread_approval", { input: body }),
    submitForm: (body) => invoke("worker_submit_thread_form", { input: body }),
  };
}
