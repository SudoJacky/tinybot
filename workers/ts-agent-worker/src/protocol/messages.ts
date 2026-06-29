export const WORKER_PROTOCOL_VERSION = "1";

export type JsonObject = Record<string, unknown>;

export type WorkerRequest = {
  protocol_version: string;
  id: string;
  trace_id: string;
  method: string;
  params?: JsonObject;
};

export type WorkerResponse = {
  protocol_version: string;
  id: string;
  trace_id: string;
  result?: unknown;
  error?: WorkerProtocolError;
};

export type WorkerEvent = {
  protocol_version: string;
  trace_id: string;
  event: string;
  payload?: JsonObject;
};

export type WorkerProtocolError = {
  code: "invalid_protocol" | "incompatible_protocol_version" | "capability_denied" | "worker_error";
  message: string;
  details: JsonObject;
  retryable: boolean;
  source: "rust_core" | "worker";
};

export function workerError(
  message: string,
  details: JsonObject = {},
  code: WorkerProtocolError["code"] = "worker_error",
): WorkerProtocolError {
  return {
    code,
    message,
    details,
    retryable: false,
    source: "worker",
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
