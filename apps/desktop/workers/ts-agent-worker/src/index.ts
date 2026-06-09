import { createInterface } from "node:readline";

import { ToolRegistry } from "./tools/toolRegistry.ts";
import { createAgentWorkerServer } from "./runtime/createAgentWorkerServer.ts";
import { createModelProvider, modelProviderConfigFromEnv } from "./runtime/providerFactory.ts";

const server = createAgentWorkerServer({
  provider: createModelProvider(modelProviderConfigFromEnv(process.env)),
  tools: new ToolRegistry(),
  writeLine: (line) => {
    process.stdout.write(`${line}\n`);
  },
  writeLog: (line) => {
    process.stderr.write(`[ts-agent-worker] ${line}\n`);
  },
});

process.stderr.write("[ts-agent-worker] ready\n");

const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

input.on("line", (line) => {
  void server.handleLine(line);
});
