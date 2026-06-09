import type { ModelProvider } from "../model/provider.ts";
import type { WorkerEvent } from "../protocol/messages.ts";
import { RpcClient } from "../protocol/rpcClient.ts";
import { StdioServer } from "../protocol/stdioServer.ts";
import { createNativeReadOnlyTools } from "../tools/nativeToolProxy.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { AgentWorker } from "./agentWorker.ts";

export type CreateAgentWorkerServerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  writeLine: (line: string) => void;
  writeLog: (line: string) => void;
};

export function createAgentWorkerServer(options: CreateAgentWorkerServerOptions): StdioServer {
  const rpcClient = new RpcClient({ writeLine: options.writeLine });
  for (const tool of createNativeReadOnlyTools(rpcClient)) {
    options.tools.register(tool);
  }
  const writeEvent = (event: WorkerEvent): void => {
    options.writeLine(JSON.stringify(event));
  };
  const worker = new AgentWorker({
    provider: options.provider,
    tools: options.tools,
    emitEvent: writeEvent,
  });
  return new StdioServer({
    worker,
    rpcClient,
    writeLine: options.writeLine,
    writeLog: options.writeLog,
  });
}
