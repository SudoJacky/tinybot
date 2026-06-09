import { createInterface } from "node:readline";

/*
For stdio worker:
- stdout is reserved for protocol JSON lines only.
- stderr is reserved for logs and diagnostics.
- Do not use console.log in TS worker.
- Use logger.info/error that writes to stderr.
*/

const WORKER_PROTOCOL_VERSION = "1";

type JsonObject = Record<string, unknown>;

type WorkerRequest = {
  protocol_version: string;
  id: string;
  trace_id: string;
  method: string;
  params?: JsonObject;
};

type WorkerResponse = {
  protocol_version: string;
  id: string;
  trace_id: string;
  result?: unknown;
  error?: WorkerProtocolError;
};

type WorkerEvent = {
  protocol_version: string;
  trace_id: string;
  event: string;
  payload?: JsonObject;
};

type WorkerProtocolError = {
  code:
    | "invalid_protocol"
    | "incompatible_protocol_version"
    | "capability_denied"
    | "worker_error";
  message: string;
  details: JsonObject;
  retryable: boolean;
  source: "rust_core" | "worker";
};

type PendingNativeRequest = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
};

const logger = {
  info(message: string) {
    process.stderr.write(`[ts-worker-fixture] ${message}\n`);
  },
  error(message: string) {
    process.stderr.write(`[ts-worker-fixture] ERROR ${message}\n`);
  },
};

const pendingNativeRequests = new Map<string, PendingNativeRequest>();
let nextNativeRequestId = 0;

function pendingKey(id: string, traceId: string): string {
  return `${id}:${traceId}`;
}

function writeProtocolLine(message: WorkerRequest | WorkerResponse | WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function workerError(
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

function sendEvent(traceId: string, event: string, payload: JsonObject): void {
  writeProtocolLine({
    protocol_version: WORKER_PROTOCOL_VERSION,
    trace_id: traceId,
    event,
    payload,
  });
}

function sendSuccess(request: WorkerRequest, result: unknown): void {
  writeProtocolLine({
    protocol_version: WORKER_PROTOCOL_VERSION,
    id: request.id,
    trace_id: request.trace_id,
    result,
  });
}

function sendFailure(request: WorkerRequest, error: WorkerProtocolError): void {
  writeProtocolLine({
    protocol_version: WORKER_PROTOCOL_VERSION,
    id: request.id,
    trace_id: request.trace_id,
    error,
  });
}

function sendNativeRequest(
  traceId: string,
  method: string,
  params: JsonObject,
): Promise<WorkerResponse> {
  const request: WorkerRequest = {
    protocol_version: WORKER_PROTOCOL_VERSION,
    id: `worker-req-${++nextNativeRequestId}`,
    trace_id: traceId,
    method,
    params,
  };
  const promise = new Promise<WorkerResponse>((resolve, reject) => {
    pendingNativeRequests.set(pendingKey(request.id, request.trace_id), {
      resolve,
      reject,
    });
  });
  writeProtocolLine(request);
  return promise;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerRequest(message: JsonObject): message is WorkerRequest {
  return (
    typeof message.id === "string" &&
    typeof message.trace_id === "string" &&
    typeof message.method === "string"
  );
}

function isWorkerResponse(message: JsonObject): message is WorkerResponse {
  return (
    typeof message.id === "string" &&
    typeof message.trace_id === "string" &&
    ("result" in message || "error" in message) &&
    !("method" in message)
  );
}

function ensureProtocolVersion(message: {
  protocol_version?: unknown;
}): WorkerProtocolError | null {
  if (message.protocol_version === WORKER_PROTOCOL_VERSION) {
    return null;
  }
  return workerError(
    `Unsupported worker protocol version '${String(message.protocol_version)}'.`,
    {
      actual: message.protocol_version ?? null,
      expected: WORKER_PROTOCOL_VERSION,
    },
    "incompatible_protocol_version",
  );
}

function handleNativeResponse(response: WorkerResponse): void {
  const key = pendingKey(response.id, response.trace_id);
  const pending = pendingNativeRequests.get(key);
  if (!pending) {
    logger.error(`received response for unknown request ${key}`);
    return;
  }
  pendingNativeRequests.delete(key);
  pending.resolve(response);
}

async function requireNativeResult(response: WorkerResponse): Promise<unknown> {
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.result;
}

function extractEchoInput(params: JsonObject | undefined): string {
  const input = params?.input;
  if (typeof input !== "string") {
    throw new Error("agent.echo requires string params.input");
  }
  return input;
}

async function handleAgentEcho(request: WorkerRequest): Promise<void> {
  sendEvent(request.trace_id, "agent.delta", { message: "starting" });

  const echo = extractEchoInput(request.params);
  const configResult = await requireNativeResult(
    await sendNativeRequest(request.trace_id, "config.get", {
      path: "agents.defaults.model",
    }),
  );
  const workspaceResult = await requireNativeResult(
    await sendNativeRequest(request.trace_id, "workspace.list_files", {}),
  );

  sendEvent(request.trace_id, "agent.delta", {
    message: "read native state",
  });

  const configValue = isObject(configResult) ? configResult.value : null;
  const workspaceFileCount = Array.isArray(workspaceResult)
    ? workspaceResult.length
    : 0;

  sendSuccess(request, {
    ok: true,
    echo,
    configValue,
    workspaceFileCount,
  });
}

async function handleWorkerRequest(request: WorkerRequest): Promise<void> {
  const versionError = ensureProtocolVersion(request);
  if (versionError) {
    sendFailure(request, versionError);
    return;
  }

  try {
    if (request.method === "agent.echo") {
      await handleAgentEcho(request);
      return;
    }

    sendFailure(
      request,
      workerError(
        "unknown worker method",
        { method: request.method },
        "invalid_protocol",
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    sendEvent(request.trace_id, "agent.error", { message });
    sendFailure(request, workerError(message));
  }
}

function handleProtocolLine(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`invalid JSON line: ${message}`);
    return;
  }

  if (!isObject(parsed)) {
    logger.error("protocol line must be a JSON object");
    return;
  }

  if (isWorkerResponse(parsed)) {
    const versionError = ensureProtocolVersion(parsed);
    if (versionError) {
      const key = pendingKey(parsed.id, parsed.trace_id);
      const pending = pendingNativeRequests.get(key);
      pendingNativeRequests.delete(key);
      pending?.reject(new Error(versionError.message));
      return;
    }
    handleNativeResponse(parsed);
    return;
  }

  if (isWorkerRequest(parsed)) {
    void handleWorkerRequest(parsed);
    return;
  }

  logger.error("protocol line is neither request nor response");
}

logger.info("ready");

const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

input.on("line", handleProtocolLine);
