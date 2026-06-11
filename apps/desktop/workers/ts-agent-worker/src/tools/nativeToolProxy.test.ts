import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import {
  createNativeApprovalTools,
  createNativeShellTools,
  createNativeFormTools,
  createNativeWriteTools,
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
  test("creates a read_file tool backed by paginated workspace.read_file", async () => {
    const rpc = new FakeRpcClient([{ path: "README.md", content: "2| hello\n3| world" }]);
    const [readFile] = createNativeReadOnlyTools(rpc);

    const result = await readFile.execute({ path: "README.md", offset: 2, limit: 2 }, { runId: "run-1", traceId: "trace-1" });

    expect(readFile.name).toBe("read_file");
    expect(readFile.readOnly).toBe(true);
    expect(readFile.concurrencySafe).toBe(true);
    expect(result.content).toBe("2| hello\n3| world");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.read_file",
        params: { path: "README.md", offset: 2, limit: 2, format: "numbered_lines" },
      },
    ]);
  });

  test("creates a list_dir tool backed by path-aware workspace.list_dir", async () => {
    const rpc = new FakeRpcClient([
      {
        entries: [
          { path: "src/", kind: "dir" },
          { path: "src/index.ts", kind: "file", size_bytes: 100 },
        ],
      },
    ]);
    const [, listDir] = createNativeReadOnlyTools(rpc);

    const result = await listDir.execute(
      { path: ".", recursive: true, max_entries: 20 },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(listDir.name).toBe("list_dir");
    expect(listDir.readOnly).toBe(true);
    expect(listDir.concurrencySafe).toBe(true);
    expect(result.content).toBe("src/\nsrc/index.ts");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.list_dir",
        params: { path: ".", recursive: true, max_entries: 20 },
      },
    ]);
  });
});

describe("createNativeWriteTools", () => {
  test("creates a write_file tool backed by workspace.write_file", async () => {
    const rpc = new FakeRpcClient([{ path: "notes/today.md", bytes_written: 5 }]);
    const [writeFile] = createNativeWriteTools(rpc);

    const result = await writeFile.execute(
      { path: "notes/today.md", content: "hello" },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(writeFile.name).toBe("write_file");
    expect(result.content).toBe("Wrote 5 bytes to notes/today.md.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.write_file",
        params: { path: "notes/today.md", contents: "hello" },
      },
    ]);
  });

  test("creates an edit_file tool that reads raw content and writes the replacement", async () => {
    const rpc = new FakeRpcClient([
      { path: "notes/today.md", content: "hello world", content_type: "text" },
      { path: "notes/today.md", bytes_written: 12 },
    ]);
    const [, editFile] = createNativeWriteTools(rpc);

    const result = await editFile.execute(
      { path: "notes/today.md", old_text: "world", new_text: "desktop" },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(editFile.name).toBe("edit_file");
    expect(result.content).toBe("Edited notes/today.md.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.read_file",
        params: { path: "notes/today.md", format: "raw" },
      },
      {
        traceId: "trace-1",
        method: "workspace.write_file",
        params: { path: "notes/today.md", contents: "hello desktop" },
      },
    ]);
  });

  test("edit_file warns when a replacement is ambiguous", async () => {
    const rpc = new FakeRpcClient([{ path: "notes/today.md", content: "repeat\nrepeat\n", content_type: "text" }]);
    const [, editFile] = createNativeWriteTools(rpc);

    const result = await editFile.execute(
      { path: "notes/today.md", old_text: "repeat", new_text: "once" },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(result.content).toBe("Warning: old_text appears 2 times. Provide more context to make it unique, or set replace_all=true.");
    expect(rpc.requests).toHaveLength(1);
  });

  test("creates a delete_file tool backed by workspace.delete_file", async () => {
    const rpc = new FakeRpcClient([{ path: "notes", deleted: true, kind: "dir" }]);
    const [, , deleteFile] = createNativeWriteTools(rpc);

    const result = await deleteFile.execute(
      { path: "notes", recursive: true },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(deleteFile.name).toBe("delete_file");
    expect(result.content).toBe("Deleted dir notes.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.delete_file",
        params: { path: "notes", recursive: true },
      },
    ]);
  });
});

describe("createNativeShellTools", () => {
  test("creates an exec tool backed by shell.execute", async () => {
    const rpc = new FakeRpcClient([
      {
        stdout: "hello\n",
        stderr: "",
        exit_code: 0,
        timed_out: false,
        blocked: false,
        truncated: false,
        content: "hello\n\nExit code: 0",
      },
    ]);
    const [exec] = createNativeShellTools(rpc);

    const result = await exec.execute(
      { command: "echo hello", working_dir: ".", timeout: 5 },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(exec.name).toBe("exec");
    expect(exec.exclusive).toBe(true);
    expect(result.content).toBe("hello\n\nExit code: 0");
    expect(result.metadata).toEqual({ exitCode: 0, timedOut: false, blocked: false, truncated: false });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "shell.execute",
        params: { command: "echo hello", working_dir: ".", timeout: 5, restrict_to_workspace: true },
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
    };
    const classification = {
      action: "require_approval",
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
      {
        operation,
        classification,
        fingerprint: "write_file:notes/today.md",
        sessionFingerprint: "write_file:notes/today.md",
        summary: "write_file path=\"notes/today.md\"",
      },
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
          classification,
          fingerprint: "write_file:notes/today.md",
          session_fingerprint: "write_file:notes/today.md",
          summary: "write_file path=\"notes/today.md\"",
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

  test("creates trace, reject, and supersede memory tools backed by native RPC", async () => {
    const rpc = new FakeRpcClient([
      {
        note: {
          id: "mem_1",
          scope: "assistant",
          type: "instruction",
          status: "active",
          content: "Use pytest for TS worker tests.",
        },
        locations: {
          file: "memory/notes.jsonl",
          line: 1,
          view_file: "SOUL.md",
          view_line: 12,
        },
      },
      {
        note: {
          id: "mem_1",
          scope: "assistant",
          type: "instruction",
          status: "rejected",
          content: "Use pytest for TS worker tests.",
        },
        views_refreshed: true,
      },
      {
        old_note: {
          id: "mem_1",
          status: "superseded",
          superseded_by: "mem_2",
        },
        note: {
          id: "mem_2",
          scope: "assistant",
          type: "instruction",
          status: "active",
          content: "Use vitest for TS worker tests.",
          supersedes: ["mem_1"],
        },
        views_refreshed: true,
      },
    ]);
    const [, , traceMemoryNote, rejectMemoryNote, supersedeMemoryNote] = createNativeMemoryTools(rpc);

    const trace = await traceMemoryNote.execute({ note_id: "mem_1" }, { runId: "run-1", traceId: "trace-1" });
    const reject = await rejectMemoryNote.execute(
      { note_id: "mem_1", reason: "obsolete" },
      { runId: "run-1", traceId: "trace-1" },
    );
    const supersede = await supersedeMemoryNote.execute(
      {
        note_id: "mem_1",
        replacement_content: "Use vitest for TS worker tests.",
        note_type: "instruction",
        scope: "assistant",
        priority: 0.8,
        confidence: 0.9,
        tags: "testing, typescript",
        metadata: "{\"reason\":\"TS worker tests run in Vitest\"}",
        message_start: 5,
        message_end: 6,
      },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(traceMemoryNote.name).toBe("trace_memory_note");
    expect(rejectMemoryNote.name).toBe("reject_memory_note");
    expect(supersedeMemoryNote.name).toBe("supersede_memory_note");
    expect(trace.content).toContain("Memory Note mem_1");
    expect(trace.content).toContain("memory/notes.jsonl:1");
    expect(reject.content).toBe("Memory Note rejected: mem_1");
    expect(supersede.content).toBe("Memory Note superseded: mem_1 -> mem_2");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "memory.trace",
        params: { note_id: "mem_1" },
      },
      {
        traceId: "trace-1",
        method: "memory.reject",
        params: { note_id: "mem_1", reason: "obsolete" },
      },
      {
        traceId: "trace-1",
        method: "memory.supersede",
        params: {
          session_id: "session-1",
          note_id: "mem_1",
          replacement_content: "Use vitest for TS worker tests.",
          note_type: "instruction",
          scope: "assistant",
          priority: 0.8,
          confidence: 0.9,
          tags: ["testing", "typescript"],
          metadata: { reason: "TS worker tests run in Vitest" },
          message_start: 5,
          message_end: 6,
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
