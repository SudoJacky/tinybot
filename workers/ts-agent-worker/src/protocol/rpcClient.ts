import { WORKER_PROTOCOL_VERSION, type JsonObject, type WorkerRequest, type WorkerResponse } from "./messages.ts";

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export type RpcClientOptions = {
  writeLine: (line: string) => void;
};

export class RpcClient {
  private readonly writeLine: (line: string) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;

  constructor(options: RpcClientOptions) {
    this.writeLine = options.writeLine;
  }

  request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    const request: WorkerRequest = {
      protocol_version: WORKER_PROTOCOL_VERSION,
      id: `worker-req-${++this.nextRequestId}`,
      trace_id: traceId,
      method,
      params,
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(pendingKey(request.id, request.trace_id), { resolve, reject });
    });
    this.writeLine(JSON.stringify(request));
    return promise;
  }

  handleResponse(response: WorkerResponse): boolean {
    const key = pendingKey(response.id, response.trace_id);
    const pending = this.pending.get(key);
    if (!pending) {
      return false;
    }
    this.pending.delete(key);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return true;
    }
    pending.resolve(response.result);
    return true;
  }
}

function pendingKey(id: string, traceId: string): string {
  return `${id}:${traceId}`;
}
