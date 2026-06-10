import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";

const DIAGNOSTICS_TRACE_ID = "worker-diagnostics";

export type DiagnosticStream = "stdout" | "stderr";

export type DiagnosticsBridge = {
  append(stream: DiagnosticStream, line: string): Promise<void>;
};

export class NativeDiagnosticsBridge implements DiagnosticsBridge {
  constructor(private readonly rpcClient: NativeRpcClient) {}

  async append(stream: DiagnosticStream, line: string): Promise<void> {
    await this.rpcClient.request(DIAGNOSTICS_TRACE_ID, "diagnostics.append", {
      stream,
      line,
    });
  }
}
