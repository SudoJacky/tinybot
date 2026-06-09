import type { AgentWorker } from "../runtime/agentWorker.ts";
import type { RpcClient } from "./rpcClient.ts";
import { isJsonObject, type WorkerRequest, type WorkerResponse } from "./messages.ts";

export type StdioServerOptions = {
  worker: AgentWorker;
  rpcClient?: RpcClient;
  writeLine: (line: string) => void;
  writeLog: (line: string) => void;
};

export class StdioServer {
  private readonly worker: AgentWorker;
  private readonly rpcClient?: RpcClient;
  private readonly writeLine: (line: string) => void;
  private readonly writeLog: (line: string) => void;

  constructor(options: StdioServerOptions) {
    this.worker = options.worker;
    this.rpcClient = options.rpcClient;
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
        this.writeLog(`received response for unknown request ${message.id}:${message.trace_id}`);
      }
      return;
    }

    const request = message;
    if (!request) {
      return;
    }
    const response = await this.worker.handleRequest(request);
    this.writeLine(JSON.stringify(response));
  }

  private parseProtocolLine(line: string): WorkerRequest | WorkerResponse | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeLog(`invalid JSON line: ${message}`);
      return null;
    }

    if (!isJsonObject(parsed)) {
      this.writeLog("protocol line must be a JSON object");
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
      this.writeLog("protocol line is not a worker request");
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
