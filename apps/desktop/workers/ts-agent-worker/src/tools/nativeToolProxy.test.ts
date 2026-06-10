import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import {
  createNativeApprovalTools,
  createNativeFormTools,
  createNativeMcpTools,
  createNativeMemoryTools,
  createNativeRagTools,
  createNativeReadOnlyTools,
} from "./nativeToolProxy";

class FakeRpcClient {
  readonly requests: Array<{ traceId: string; method: string; params: JsonObject }> = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = responses;
  }

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe("createNativeReadOnlyTools", () => {
  test("creates a read_file tool backed by workspace.read_file", async () => {
    const rpc = new FakeRpcClient([{ path: "README.md", contents: "hello\nworld" }]);
    const [readFile] = createNativeReadOnlyTools(rpc);

    const result = await readFile.execute({ path: "README.md" }, { runId: "run-1", traceId: "trace-1" });

    expect(readFile.name).toBe("read_file");
    expect(result.content).toBe("hello\nworld");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.read_file",
        params: { path: "README.md" },
      },
    ]);
  });

  test("creates a list_dir tool backed by workspace.list_files", async () => {
    const rpc = new FakeRpcClient([
      [
        { path: "README.md", kind: "file", bytes: 12 },
        { path: "src/index.ts", kind: "file", bytes: 100 },
      ],
    ]);
    const [, listDir] = createNativeReadOnlyTools(rpc);

    const result = await listDir.execute({}, { runId: "run-1", traceId: "trace-1" });

    expect(listDir.name).toBe("list_dir");
    expect(result.content).toBe("README.md\nsrc/index.ts");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.list_files",
        params: {},
      },
    ]);
  });
});

describe("createNativeFormTools", () => {
  test("creates a request_form tool backed by form.request", async () => {
    const form = {
      form_id: "travel_plan",
      title: "Travel plan",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    };
    const rpc = new FakeRpcClient([
      {
        content: "Waiting for form submission.",
        awaitingUserInput: true,
        stopReason: "awaiting_form",
        formId: "travel_plan",
        form,
        continuationMode: "resume",
      },
    ]);
    const [requestForm] = createNativeFormTools(rpc);

    const result = await requestForm.execute(
      { form, continuation_mode: "resume" },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(requestForm.name).toBe("request_form");
    expect(result).toEqual({
      content: "Waiting for form submission.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_form",
        formId: "travel_plan",
        form,
        continuationMode: "resume",
      },
    });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "form.request",
        params: {
          run_id: "run-1",
          session_id: "session-1",
          form,
          continuation_mode: "resume",
        },
      },
    ]);
  });
});

describe("createNativeApprovalTools", () => {
  test("creates a request_approval tool backed by approval.request", async () => {
    const operation = {
      toolName: "write_file",
      arguments: { path: "notes/today.md", contents: "hello" },
      category: "filesystem_write",
      risk: "medium",
      reason: "File write/edit/delete tools can modify workspace state.",
    };
    const rpc = new FakeRpcClient([
      {
        content: "Waiting for approval.",
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation,
      },
    ]);
    const [requestApproval] = createNativeApprovalTools(rpc);

    const result = await requestApproval.execute(
      { operation },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(requestApproval.name).toBe("request_approval");
    expect(result).toEqual({
      content: "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation,
      },
    });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "approval.request",
        params: {
          run_id: "run-1",
          session_id: "session-1",
          operation,
        },
      },
    ]);
  });
});

describe("createNativeMemoryTools", () => {
  test("creates a search_memory_notes tool backed by memory.search", async () => {
    const rpc = new FakeRpcClient([
      {
        notes: [
          {
            id: "mem_1",
            scope: "user",
            type: "preference",
            status: "active",
            priority: 0.8,
            confidence: 0.7,
            content: "User prefers concise implementation handoffs.",
            sources: [{ capture_origin: "explicit", session_key: "session-1" }],
          },
        ],
      },
    ]);
    const [searchMemoryNotes] = createNativeMemoryTools(rpc);

    const result = await searchMemoryNotes.execute(
      { query: "handoff", note_type: "preference", status: "active", limit: 5 },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(searchMemoryNotes.name).toBe("search_memory_notes");
    expect(result.content).toContain("## Memory Notes");
    expect(result.content).toContain("[mem_1] user/preference/active");
    expect(result.content).toContain("User prefers concise implementation handoffs.");
    expect(result.metadata).toEqual({
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
          file: undefined,
          line: undefined,
          view_file: undefined,
          view_line: undefined,
        },
      ],
    });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "memory.search",
        params: {
          query: "handoff",
          note_type: "preference",
          status: "active",
          limit: 5,
        },
      },
    ]);
  });

  test("creates a save_memory_note tool backed by memory.save", async () => {
    const rpc = new FakeRpcClient([
      {
        note: {
          id: "mem_1",
          type: "preference",
          status: "active",
          content: "User prefers concise implementation handoffs.",
        },
      },
    ]);
    const [, saveMemoryNote] = createNativeMemoryTools(rpc);

    const result = await saveMemoryNote.execute(
      {
        content: "User prefers concise implementation handoffs.",
        note_type: "preference",
        priority: 0.8,
        confidence: 0.7,
        tags: "handoff, communication",
        metadata: "{\"source\":\"desktop\"}",
        message_start: 3,
        message_end: 4,
      },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(saveMemoryNote.name).toBe("save_memory_note");
    expect(result.content).toBe("Memory Note saved: mem_1 (preference, active)");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "memory.save",
        params: {
          session_id: "session-1",
          content: "User prefers concise implementation handoffs.",
          note_type: "preference",
          priority: 0.8,
          confidence: 0.7,
          tags: ["handoff", "communication"],
          metadata: { source: "desktop" },
          message_start: 3,
          message_end: 4,
        },
      },
    ]);
  });
});

describe("createNativeRagTools", () => {
  test("creates a query_rag tool backed by rag.query", async () => {
    const rpc = new FakeRpcClient([
      {
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
    ]);
    const [queryRag] = createNativeRagTools(rpc);

    const result = await queryRag.execute(
      { query: "TS worker bridge", collection: "docs", limit: 3 },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(queryRag.name).toBe("query_rag");
    expect(result.content).toContain("## RAG Results");
    expect(result.content).toContain("[doc-1] TS Agent Loop Design");
    expect(result.content).toContain("TS worker should proxy product integrations through Rust.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "rag.query",
        params: {
          session_id: "session-1",
          query: "TS worker bridge",
          collection: "docs",
          limit: 3,
        },
      },
    ]);
  });
});

describe("createNativeMcpTools", () => {
  test("creates a call_mcp_tool tool backed by mcp.call_tool", async () => {
    const rpc = new FakeRpcClient([
      {
        content: "MCP search result",
        server: "docs",
        tool: "search",
      },
    ]);
    const [callMcpTool] = createNativeMcpTools(rpc);

    const result = await callMcpTool.execute(
      {
        server: "docs",
        tool: "search",
        arguments: { query: "agent loop" },
      },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(callMcpTool.name).toBe("call_mcp_tool");
    expect(result.content).toBe("MCP search result");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "mcp.call_tool",
        params: {
          session_id: "session-1",
          server: "docs",
          tool: "search",
          arguments: { query: "agent loop" },
        },
      },
    ]);
  });
});
