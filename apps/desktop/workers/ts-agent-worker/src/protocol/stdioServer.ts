import type { AgentWorker } from "../runtime/agentWorker.ts";
import { NativeDiagnosticsBridge, type DiagnosticsBridge } from "../runtime/diagnosticsBridge.ts";
import type { RpcClient } from "./rpcClient.ts";
import { isJsonObject, type WorkerRequest, type WorkerResponse } from "./messages.ts";

export type StdioServerOptions = {
  worker: AgentWorker;
  diagnosticsBridge?: DiagnosticsBridge;
  rpcClient?: RpcClient;
  now?: () => number;
  writeLine: (line: string) => void;
  writeLog: (line: string) => void;
};

export class StdioServer {
  private readonly worker: AgentWorker;
  private readonly diagnosticsBridge?: DiagnosticsBridge;
  private readonly rpcClient?: RpcClient;
  private readonly now: () => number;
  private readonly writeLine: (line: string) => void;
  private readonly writeLog: (line: string) => void;

  constructor(options: StdioServerOptions) {
    this.worker = options.worker;
    this.diagnosticsBridge = options.diagnosticsBridge ?? (options.rpcClient ? new NativeDiagnosticsBridge(options.rpcClient) : undefined);
    this.rpcClient = options.rpcClient;
    this.now = options.now ?? Date.now;
    this.writeLine = options.writeLine;
    this.writeLog = options.writeLog;
  }

  async handleLine(line: string): Promise<void> {
    const message = this.parseProtocolLine(line);
    if (!message) {
      return;
    }
    if (isWorkerResponse(message)) {
      if (!this.rpcClient?.handleResponse(message)) {
        this.logDiagnostic(`received response for unknown request ${message.id}:${message.trace_id}`);
      }
      return;
    }

    const request = message;
    if (!request) {
      return;
    }
    const trace = this.traceRequestStart(request);
    const response = await this.worker.handleRequest(request);
    this.traceRequestComplete(request, response, trace);
    this.writeLine(JSON.stringify(response));
  }

  private parseProtocolLine(line: string): WorkerRequest | WorkerResponse | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logDiagnostic(`invalid JSON line: ${message}`);
      return null;
    }

    if (!isJsonObject(parsed)) {
      this.logDiagnostic("protocol line must be a JSON object");
      return null;
    }

    if (isWorkerResponse(parsed)) {
      return parsed;
    }

    if (
      typeof parsed.protocol_version !== "string" ||
      typeof parsed.id !== "string" ||
      typeof parsed.trace_id !== "string" ||
      typeof parsed.method !== "string"
    ) {
      this.logDiagnostic("protocol line is not a worker request");
      return null;
    }

    return {
      protocol_version: parsed.protocol_version,
      id: parsed.id,
      trace_id: parsed.trace_id,
      method: parsed.method,
      params: isJsonObject(parsed.params) ? parsed.params : undefined,
    };
  }

  private logDiagnostic(line: string): void {
    this.writeLog(line);
    void this.diagnosticsBridge?.append("stderr", line).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.writeLog(`failed to append native diagnostic: ${message}`);
    });
  }

  private traceRequestStart(request: WorkerRequest): { startedAt: number; traced: boolean } {
    const startedAt = this.now();
    if (!shouldTraceRequest(request)) {
      return { startedAt, traced: false };
    }
    const route = routeSummary(request);
    const queuedMs = queuedDurationMs(request, startedAt);
    this.logDiagnostic([
      "worker.request.start",
      `method=${request.method}`,
      `id=${request.id}`,
      route ? `route=${route}` : "",
      queuedMs === null ? "" : `queuedMs=${roundedDuration(queuedMs)}`,
    ].filter(Boolean).join(" "));
    return { startedAt, traced: true };
  }

  private traceRequestComplete(
    request: WorkerRequest,
    response: WorkerResponse,
    trace: { startedAt: number; traced: boolean },
  ): void {
    if (!trace.traced) {
      return;
    }
    const route = routeSummary(request);
    const status = response.error ? "error" : "ok";
    this.logDiagnostic([
      "worker.request.complete",
      `method=${request.method}`,
      `id=${request.id}`,
      route ? `route=${route}` : "",
      `durationMs=${roundedDuration(this.now() - trace.startedAt)}`,
      `status=${status}`,
    ].filter(Boolean).join(" "));
  }
}

function isWorkerResponse(message: Record<string, unknown>): message is WorkerResponse {
  return (
    typeof message.protocol_version === "string" &&
    typeof message.id === "string" &&
    typeof message.trace_id === "string" &&
    ("result" in message || "error" in message) &&
    !("method" in message)
  );
}

function shouldTraceRequest(request: WorkerRequest): boolean {
  return request.method === "webui.handle_request";
}

function routeSummary(request: WorkerRequest): string {
  const method = typeof request.params?.method === "string" ? request.params.method : "";
  const path = typeof request.params?.path === "string" ? request.params.path : "";
  return method || path ? `${method || "?"} ${path || "?"}` : "";
}

function queuedDurationMs(request: WorkerRequest, startedAt: number): number | null {
  const match = /^webui-route-(\d+)$/.exec(request.id);
  if (!match) {
    return null;
  }
  const enqueuedAt = Number(match[1]);
  return Number.isFinite(enqueuedAt) ? Math.max(0, startedAt - enqueuedAt) : null;
}

function roundedDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
