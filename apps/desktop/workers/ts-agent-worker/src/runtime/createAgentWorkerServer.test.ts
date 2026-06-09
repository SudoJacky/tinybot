import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelResponse } from "../model/provider";
import { ToolRegistry } from "../tools/toolRegistry";
import { createAgentWorkerServer } from "./createAgentWorkerServer";

class QueueProvider implements ModelProvider {
  readonly requests: AgentMessage[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[]): Promise<ModelResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("createAgentWorkerServer", () => {
  test("wires stdio requests to the injected model provider", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "factory done", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    const messages = lines.map((line) => JSON.parse(line));
    expect(messages).toEqual([
      expect.objectContaining({
        event: "agent.checkpoint",
        payload: expect.objectContaining({ phase: "final_response", runId: "run-1" }),
      }),
      expect.objectContaining({ event: "agent.done" }),
      expect.objectContaining({
        result: expect.objectContaining({ finalContent: "factory done" }),
      }),
    ]);
  });

  test("registers native read-only tools that can call back into Rust over stdio", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        stopReason: "tool_calls",
      },
      { content: "final", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "read README" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "workspace.read_file"));
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      protocol_version: "1",
      id: "worker-req-1",
      trace_id: "trace-1",
      method: "workspace.read_file",
      params: { path: "README.md" },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "worker-req-1",
        trace_id: "trace-1",
        result: { path: "README.md", contents: "hello" },
      }),
    );
    await run;

    const messages = lines.map((line) => JSON.parse(line));
    expect(messages.at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "final", stopReason: "final_response" },
    });
    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: "hello",
      toolCallId: "call-1",
      name: "read_file",
    });
  });
});

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
