import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelResponse } from "../model/provider";
import { ToolRegistry } from "../tools/toolRegistry";
import { createAgentWorkerServer } from "./createAgentWorkerServer";
import type { ModelProviderConfig } from "./providerFactory";

type ParsedLine = {
  id?: unknown;
  trace_id?: unknown;
  method?: unknown;
  params?: { path?: unknown };
};

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

  test("writes usage protocol events before the final agent response", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([
        {
          content: "usage done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        },
      ]),
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
      expect.objectContaining({
        event: "agent.usage",
        payload: {
          runId: "run-1",
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        },
      }),
      expect.objectContaining({ event: "agent.done" }),
      expect.objectContaining({
        result: expect.objectContaining({
          finalContent: "usage done",
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        }),
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

  test("registers request_form tool that pauses the run through native form RPC", async () => {
    const form = {
      form_id: "travel_plan",
      title: "Travel plan",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    };
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "request_form", argumentsJson: JSON.stringify({ form }) }],
        stopReason: "tool_calls",
      },
      { content: "should not be requested", toolCalls: [], stopReason: "stop" },
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
            messages: [{ role: "user", content: "collect travel details" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "form.request"));
    const formRequest = parsedLines(lines).find((line) => line.method === "form.request");
    expect(formRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "form.request",
      params: {
        run_id: "run-1",
        form,
        continuation_mode: "structured_message",
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: formRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "Waiting for form submission.",
          awaitingUserInput: true,
          stopReason: "awaiting_form",
          formId: "travel_plan",
          form,
          continuationMode: "structured_message",
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.awaiting_form",
        payload: expect.objectContaining({
          runId: "run-1",
          stopReason: "awaiting_form",
          formId: "travel_plan",
          form,
        }),
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "", stopReason: "awaiting_form" },
    });
  });

  test("registers request_approval tool that pauses the run through native approval RPC", async () => {
    const operation = {
      toolName: "write_file",
      arguments: { path: "notes/today.md", contents: "hello" },
      category: "filesystem_write",
      risk: "medium",
      reason: "File write/edit/delete tools can modify workspace state.",
    };
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "request_approval", argumentsJson: JSON.stringify({ operation }) }],
        stopReason: "tool_calls",
      },
      { content: "should not be requested", toolCalls: [], stopReason: "stop" },
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
            messages: [{ role: "user", content: "write a file" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.request"));
    const approvalRequest = parsedLines(lines).find((line) => line.method === "approval.request");
    expect(approvalRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "approval.request",
      params: {
        run_id: "run-1",
        operation,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "Waiting for approval.",
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          operation,
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.awaiting_approval",
        payload: expect.objectContaining({
          runId: "run-1",
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          operation,
        }),
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "", stopReason: "awaiting_approval" },
    });
  });

  test("registers memory tools that call native memory RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "search_memory_notes",
            argumentsJson: JSON.stringify({ query: "handoff", note_type: "preference", status: "active", limit: 5 }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "memory checked", toolCalls: [], stopReason: "stop" },
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
            messages: [{ role: "user", content: "recall memory" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.search"));
    const memoryRequest = parsedLines(lines).find((line) => line.method === "memory.search");
    expect(memoryRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "memory.search",
      params: {
        query: "handoff",
        note_type: "preference",
        status: "active",
        limit: 5,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: memoryRequest?.id,
        trace_id: "trace-1",
        result: {
          notes: [
            {
              id: "mem_1",
              scope: "user",
              type: "preference",
              status: "active",
              priority: 0.8,
              confidence: 0.7,
              content: "User prefers concise implementation handoffs.",
              file: "memory/notes.jsonl",
              line: 1,
              view_file: "USER.md",
              view_line: 12,
              sources: [{ capture_origin: "explicit", session_key: "session-1" }],
            },
          ],
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: expect.stringContaining("User prefers concise implementation handoffs."),
      toolCallId: "call-1",
      name: "search_memory_notes",
      metadata: {
        _memory_references: [
          {
            note_id: "mem_1",
            scope: "user",
            type: "preference",
            status: "active",
            content: "User prefers concise implementation handoffs.",
            priority: 0.8,
            confidence: 0.7,
            tags: [],
            metadata: {},
            evidence_ids: [],
            file: "memory/notes.jsonl",
            line: 1,
            view_file: "USER.md",
            view_line: 12,
          },
        ],
      },
    });
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.memory_reference",
        payload: {
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "search_memory_notes",
          references: [
            {
              note_id: "mem_1",
              scope: "user",
              type: "preference",
              status: "active",
              content: "User prefers concise implementation handoffs.",
              priority: 0.8,
              confidence: 0.7,
              tags: [],
              metadata: {},
              evidence_ids: [],
              file: "memory/notes.jsonl",
              line: 1,
              view_file: "USER.md",
              view_line: 12,
            },
          ],
        },
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "memory checked", stopReason: "final_response" },
    });
  });

  test("registers RAG tools that call native rag RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-rag",
            name: "query_rag",
            argumentsJson: JSON.stringify({ query: "TS worker bridge", collection: "docs", limit: 3 }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "rag checked", toolCalls: [], stopReason: "stop" },
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
            messages: [{ role: "user", content: "query RAG" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "rag.query"));
    const ragRequest = parsedLines(lines).find((line) => line.method === "rag.query");
    expect(ragRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "rag.query",
      params: {
        query: "TS worker bridge",
        collection: "docs",
        limit: 3,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: ragRequest?.id,
        trace_id: "trace-1",
        result: {
          documents: [
            {
              id: "doc-1",
              title: "TS Agent Loop Design",
              path: "docs/ts-agent-loop.md",
              score: 0.91,
              excerpt: "TS worker should proxy product integrations through Rust.",
            },
          ],
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: expect.stringContaining("TS worker should proxy product integrations through Rust."),
      toolCallId: "call-rag",
      name: "query_rag",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "rag checked", stopReason: "final_response" },
    });
  });

  test("registers MCP tools that call native mcp RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-mcp",
            name: "call_mcp_tool",
            argumentsJson: JSON.stringify({
              server: "docs",
              tool: "search",
              arguments: { query: "agent loop" },
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "mcp checked", toolCalls: [], stopReason: "stop" },
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
            messages: [{ role: "user", content: "call MCP" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "mcp.call_tool"));
    const mcpRequest = parsedLines(lines).find((line) => line.method === "mcp.call_tool");
    expect(mcpRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "mcp.call_tool",
      params: {
        server: "docs",
        tool: "search",
        arguments: { query: "agent loop" },
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: mcpRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "MCP search result",
          server: "docs",
          tool: "search",
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: "MCP search result",
      toolCallId: "call-mcp",
      name: "call_mcp_tool",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "mcp checked", stopReason: "final_response" },
    });
  });

  test("loads model provider config from native config when provider is not injected", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "native config done", toolCalls: [], stopReason: "stop" }]);
    const createdConfigs: ModelProviderConfig[] = [];
    const server = createAgentWorkerServer({
      tools: new ToolRegistry(),
      env: { OPENAI_API_KEY: "env-key" },
      createModelProvider: (config) => {
        createdConfigs.push(config);
        return provider;
      },
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
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigGet(server, lines, "agents.defaults.provider", "openai");
    await respondToConfigGet(server, lines, "agents.defaults.model", "gpt-5");
    await respondToConfigGet(server, lines, "providers.openai", {
      provider: "openai",
      api_base: "https://api.test/v1",
      api_key: null,
    });
    await run;

    expect(createdConfigs).toEqual([
      {
        kind: "openai",
        apiKey: "env-key",
        baseURL: "https://api.test/v1",
        model: "gpt-5",
      },
    ]);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "native config done", stopReason: "final_response" },
    });
  });

  test("persists checkpoint and appends messages through native session RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
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
            sessionId: "session-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.set_checkpoint"));
    const setRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.set_checkpoint");
    expect(setRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: {
          runId: "run-1",
          phase: "final_response",
          iteration: 0,
          model: "test-model",
        },
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setRequest.id,
        trace_id: "trace-1",
        result: { ok: true },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.clear_checkpoint"));
    const clearRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.clear_checkpoint");
    expect(clearRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "session.clear_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: clearRequest.id,
        trace_id: "trace-1",
        result: { ok: true },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.append_messages"));
    const appendRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.append_messages");
    expect(appendRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "session.append_messages",
      params: {
        session_id: "session-1",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
        ],
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: appendRequest.id,
        trace_id: "trace-1",
        result: { ok: true },
      }),
    );
    await run;

    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "done", stopReason: "final_response" },
    });
  });

  test("restores checkpoint through native session RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const restore = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "restore-1",
        trace_id: "trace-restore",
        method: "agent.restore_checkpoint",
        params: { sessionId: "session-1" },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.get_checkpoint"));
    const checkpointRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-restore",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest.id,
        trace_id: "trace-restore",
        result: {
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
        },
      }),
    );
    await restore;

    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "restore-1",
      trace_id: "trace-restore",
      result: {
        sessionId: "session-1",
        checkpoint: {
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
        },
      },
    });
  });

  test("resumes approval through native approval and session RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const resume = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "resume-approval-1",
        trace_id: "trace-resume",
        method: "agent.resume_approval",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: true,
          scope: "session",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.resolve"));
    const approvalRequest = parsedLines(lines).find((message) => message.method === "approval.resolve");
    expect(approvalRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume",
      method: "approval.resolve",
      params: {
        session_id: "session-1",
        approval_id: "approval-1",
        approved: true,
        scope: "session",
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-resume",
        result: {
          approvalId: "approval-1",
          approved: true,
          scope: "session",
          status: "approved",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-resume",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        },
      }),
    );
    await resume;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "resume-approval-1",
      trace_id: "trace-resume",
      result: {
        sessionId: "session-1",
        approval: {
          approvalId: "approval-1",
          approved: true,
          scope: "session",
          status: "approved",
        },
        checkpoint: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        },
      },
    });
  });

  test("continues denied approval through native approval and session RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "No file will be written.", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const resume = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "resume-approval-1",
        trace_id: "trace-resume-denied",
        method: "agent.resume_approval",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: false,
          scope: "once",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.resolve"));
    const approvalRequest = parsedLines(lines).find((message) => message.method === "approval.resolve");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-resume-denied",
        result: {
          approvalId: "approval-1",
          approved: false,
          scope: "once",
          status: "denied",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-resume-denied",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
          maxIterations: 2,
          stream: false,
          messages: [
            { role: "user", content: "write a file" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "approval-call-1", name: "request_approval", argumentsJson: "{}" }],
            },
            {
              role: "tool",
              content: "Waiting for approval.",
              toolCallId: "approval-call-1",
              name: "request_approval",
              metadata: {
                awaitingUserInput: true,
                stopReason: "awaiting_approval",
                approvalId: "approval-1",
                operation: {
                  toolName: "write_file",
                  arguments: { path: "notes/today.md", contents: "hello" },
                },
              },
            },
          ],
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.set_checkpoint"));
    const setCheckpointRequest = parsedLines(lines).find((message) => message.method === "session.set_checkpoint");
    expect(setCheckpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume-denied",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: expect.objectContaining({
          runId: "run-1",
          phase: "final_response",
        }),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setCheckpointRequest?.id,
        trace_id: "trace-resume-denied",
        result: { session_id: "session-1" },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.clear_checkpoint"));
    const clearRequest = parsedLines(lines).find((message) => message.method === "session.clear_checkpoint");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: clearRequest?.id,
        trace_id: "trace-resume-denied",
        result: { session_id: "session-1" },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.append_messages"));
    const appendRequest = parsedLines(lines).find((message) => message.method === "session.append_messages");
    expect(appendRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume-denied",
      method: "session.append_messages",
      params: {
        session_id: "session-1",
        messages: expect.arrayContaining([
          {
            role: "tool",
            content: "Approval denied: approval-1",
            toolCallId: "approval-call-1",
            name: "request_approval",
            metadata: {
              approvalId: "approval-1",
              approved: false,
              status: "denied",
            },
          },
        ]),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: appendRequest?.id,
        trace_id: "trace-resume-denied",
        result: { session_id: "session-1" },
      }),
    );
    await resume;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "resume-approval-1",
      trace_id: "trace-resume-denied",
      result: {
        approval: {
          approvalId: "approval-1",
          approved: false,
          scope: "once",
          status: "denied",
        },
        result: {
          finalContent: "No file will be written.",
          stopReason: "final_response",
        },
      },
    });
  });

  test("submits a form through native session checkpoint and continues the run", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "trip captured", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const submit = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "submit-form-1",
        trace_id: "trace-submit-form",
        method: "agent.submit_form",
        params: {
          sessionId: "session-1",
          formId: "travel_plan",
          values: { destination: "Paris" },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-submit-form",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
          maxIterations: 2,
          stream: false,
          messages: [
            { role: "user", content: "plan a trip" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "form-call-1", name: "request_form", argumentsJson: "{}" }],
            },
            {
              role: "tool",
              content: "Waiting for form submission.",
              toolCallId: "form-call-1",
              name: "request_form",
              metadata: {
                awaitingUserInput: true,
                stopReason: "awaiting_form",
                formId: "travel_plan",
              },
            },
          ],
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.set_checkpoint"));
    const setRequest = parsedLines(lines).find((message) => message.method === "session.set_checkpoint");
    expect(setRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: expect.objectContaining({
          runId: "run-1",
          phase: "final_response",
          model: "test-model",
        }),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setRequest?.id,
        trace_id: "trace-submit-form",
        result: { ok: true },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.clear_checkpoint"));
    const clearRequest = parsedLines(lines).find((message) => message.method === "session.clear_checkpoint");
    expect(clearRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.clear_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: clearRequest?.id,
        trace_id: "trace-submit-form",
        result: { ok: true },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.append_messages"));
    const appendRequest = parsedLines(lines).find((message) => message.method === "session.append_messages");
    expect(appendRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.append_messages",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: appendRequest?.id,
        trace_id: "trace-submit-form",
        result: { ok: true },
      }),
    );
    await submit;

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toContainEqual({
      role: "tool",
      content: "Agent UI form submitted: travel_plan\n{\"destination\":\"Paris\"}",
      toolCallId: "form-call-1",
      name: "request_form",
      metadata: {
        formId: "travel_plan",
        action: "submitted",
        values: { destination: "Paris" },
      },
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "submit-form-1",
      trace_id: "trace-submit-form",
      result: {
        sessionId: "session-1",
        form: {
          formId: "travel_plan",
          action: "submitted",
          values: { destination: "Paris" },
        },
        result: {
          finalContent: "trip captured",
          stopReason: "final_response",
        },
      },
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

async function respondToConfigGet(server: ReturnType<typeof createAgentWorkerServer>, lines: string[], path: string, value: unknown): Promise<void> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === "config.get" && line.params?.path === path));
  const request = parsedLines(lines).find((line) => line.method === "config.get" && line.params?.path === path);
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error(`missing config.get request for ${path}`);
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: { path, value },
    }),
  );
}

function parsedLines(lines: string[]): ParsedLine[] {
  return lines.map((line) => JSON.parse(line));
}
