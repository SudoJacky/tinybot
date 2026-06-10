import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelResponse } from "../model/provider";
import { AgentWorker } from "../runtime/agentWorker";
import { ToolRegistry } from "../tools/toolRegistry";
import { RpcClient } from "./rpcClient";
import { StdioServer } from "./stdioServer";

class QueueProvider implements ModelProvider {
  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_messages: AgentMessage[]): Promise<ModelResponse> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

class DeferredProvider implements ModelProvider {
  private resolveResponse: ((response: ModelResponse) => void) | null = null;
  private resolveStarted: () => void = () => undefined;

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async complete(_messages: AgentMessage[]): Promise<ModelResponse> {
    this.resolveStarted();
    return new Promise<ModelResponse>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  resolve(response: ModelResponse): void {
    this.resolveResponse?.(response);
  }
}

describe("StdioServer", () => {
  test("writes agent.run events and response as protocol JSON lines", async () => {
    const lines: string[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: (event) => lines.push(JSON.stringify(event)),
    });
    const server = new StdioServer({
      worker,
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

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        protocol_version: "1",
        trace_id: "trace-1",
        event: "agent.checkpoint",
        payload: {
          runId: "run-1",
          run_id: "run-1",
          phase: "final_response",
          iteration: 0,
          model: "test-model",
          assistantMessage: { role: "assistant", content: "done" },
          assistant_message: { role: "assistant", content: "done" },
          completedToolResults: [],
          completed_tool_results: [],
          pendingToolCalls: [],
          pending_tool_calls: [],
        },
      },
      {
        protocol_version: "1",
        trace_id: "trace-1",
        event: "agent.done",
        payload: expect.objectContaining({
          runId: "run-1",
          stopReason: "final_response",
        }),
      },
      {
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        result: expect.objectContaining({
          finalContent: "done",
          stopReason: "final_response",
        }),
      },
    ]);
  });

  test("routes protocol responses to the worker RPC client", async () => {
    const lines: string[] = [];
    const logs: string[] = [];
    const rpcClient = new RpcClient({ writeLine: (line) => lines.push(line) });
    const server = new StdioServer({
      worker: new AgentWorker({
        provider: new QueueProvider([]),
        tools: new ToolRegistry(),
        emitEvent: () => undefined,
      }),
      rpcClient,
      writeLine: (line) => lines.push(line),
      writeLog: (line) => logs.push(line),
    });
    const pending = rpcClient.request("trace-1", "workspace.read_file", { path: "README.md" });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "worker-req-1",
        trace_id: "trace-1",
        result: { path: "README.md", contents: "hello" },
      }),
    );

    await expect(pending).resolves.toEqual({ path: "README.md", contents: "hello" });
    expect(logs).toEqual([]);
  });

  test("handles agent.cancel while an agent.run request is still pending", async () => {
    const lines: string[] = [];
    const provider = new DeferredProvider();
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => lines.push(JSON.stringify(event)),
    });
    const server = new StdioServer({
      worker,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "run-req",
        trace_id: "trace-run",
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
    await provider.started;

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "cancel-req",
        trace_id: "trace-cancel",
        method: "agent.cancel",
        params: { runId: "run-1" },
      }),
    );

    const parsedBeforeRunCompletes = lines.map((line) => JSON.parse(line));
    expect(parsedBeforeRunCompletes).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-run",
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "run-1" }),
    }));
    expect(parsedBeforeRunCompletes).toContainEqual({
      protocol_version: "1",
      id: "cancel-req",
      trace_id: "trace-cancel",
      result: { ok: true, runId: "run-1" },
    });
    expect(parsedBeforeRunCompletes.some((message) => message.id === "run-req")).toBe(false);

    provider.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    await run;

    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      protocol_version: "1",
      id: "run-req",
      trace_id: "trace-run",
      result: expect.objectContaining({
        stopReason: "cancelled",
        error: "cancelled",
      }),
    });
  });

  test("forwards protocol parser diagnostics to native diagnostics RPC", async () => {
    const lines: string[] = [];
    const logs: string[] = [];
    const rpcClient = new RpcClient({ writeLine: (line) => lines.push(line) });
    const server = new StdioServer({
      worker: new AgentWorker({
        provider: new QueueProvider([]),
        tools: new ToolRegistry(),
        emitEvent: () => undefined,
      }),
      rpcClient,
      writeLine: (line) => lines.push(line),
      writeLog: (line) => logs.push(line),
    });

    await server.handleLine("{not-json");

    expect(JSON.parse(lines[0])).toMatchObject({
      protocol_version: "1",
      trace_id: "worker-diagnostics",
      method: "diagnostics.append",
      params: {
        stream: "stderr",
        line: expect.stringContaining("invalid JSON line:"),
      },
    });
    expect(logs[0]).toContain("invalid JSON line:");
  });
});
