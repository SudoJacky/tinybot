import { createInterface } from "node:readline";

import { ToolRegistry } from "./tools/toolRegistry.ts";
import { createAgentWorkerServer } from "./runtime/createAgentWorkerServer.ts";

const server = createAgentWorkerServer({
  tools: new ToolRegistry(),
  env: process.env,
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
