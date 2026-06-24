import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import {
  createNativeApprovalTools,
  createNativeShellTools,
  createNativeFormTools,
  createNativeWriteTools,
  createNativeMcpTools,
  createNativeMemoryTools,
  createNativeRagTools,
  createNativeReadOnlyTools,
  createNativeSpawnTools,
  createNativeTaskTools,
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

class QueueProvider implements ModelProvider {
  readonly requests: Array<{ messages: AgentMessage[]; options?: ModelRequestOptions }> = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push({ messages, options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
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
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(writeFile.name).toBe("write_file");
    expect(result.content).toBe("Wrote 5 bytes to notes/today.md.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.write_file",
        params: { path: "notes/today.md", contents: "hello", run_id: "run-1", session_id: "session-1" },
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
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
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
        params: { path: "notes/today.md", contents: "hello desktop", run_id: "run-1", session_id: "session-1" },
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
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(deleteFile.name).toBe("delete_file");
    expect(result.content).toBe("Deleted dir notes.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.delete_file",
        params: { path: "notes", recursive: true, run_id: "run-1", session_id: "session-1" },
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
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(exec.name).toBe("exec");
    expect(exec.exclusive).toBe(true);
    expect(result.content).toBe("hello\n\nExit code: 0");
    expect(result.metadata).toEqual({ exitCode: 0, timedOut: false, blocked: false, truncated: false });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "shell.execute",
        params: { command: "echo hello", working_dir: ".", timeout: 5, restrict_to_workspace: true, run_id: "run-1", session_id: "session-1" },
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

describe("createNativeTaskTools", () => {
  test("runs resumed subtasks through an isolated AgentRunner tool registry", async () => {
    const plan = taskPlan({ status: "planning", subtaskStatus: "pending" });
    const inProgressPlan = taskPlan({ status: "executing", subtaskStatus: "in_progress" });
    const completedPlan = taskPlan({ status: "completed", subtaskStatus: "completed", result: "inspection used tools" });
    const rpc = new FakeRpcClient([
      { plan },
      { plan },
      { plan: inProgressPlan },
      { path: "AGENTS.md", content: "Use UV for Python." },
      { plan: inProgressPlan },
      { plan: completedPlan },
    ]);
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"AGENTS.md\"}" }],
        stopReason: "tool_calls",
      },
      { content: "inspection used tools", toolCalls: [], stopReason: "stop" },
    ]);
    const [taskTool] = createNativeTaskTools(rpc, { provider, model: "test-model" });

    const result = await taskTool.execute(
      { action: "resume", plan_id: "plan-1", parallel: false },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );
    await waitFor(() => rpc.requests.filter((request) => request.method === "task.plan.save").length === 2);

    expect(result.content).toBe("任务已后台启动，SubAgent自动执行中。完成后会通知你。无需主动干预。（plan_id: plan-1，启动 1 个子任务）");
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "edit_file",
      "delete_file",
      "exec",
      "request_approval",
    ]);
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).not.toContain("task");
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).not.toContain("cron");
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "task.plan.get",
      "task.plan.get",
      "task.plan.save",
      "workspace.read_file",
      "task.plan.get",
      "task.plan.save",
    ]);
    expect(rpc.requests[3]).toMatchObject({
      traceId: "trace-1",
      method: "workspace.read_file",
      params: { path: "AGENTS.md", format: "numbered_lines" },
    });
  });
});

describe("createNativeSpawnTools", () => {
  test("runs spawned subagents through an isolated AgentRunner tool registry", async () => {
    const rpc = new FakeRpcClient([{ path: "AGENTS.md", content: "1| Use UV for Python." }]);
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"AGENTS.md\"}" }],
        stopReason: "tool_calls",
      },
      { content: "inspection complete", toolCalls: [], stopReason: "stop" },
    ]);
    const [spawnTool] = createNativeSpawnTools(rpc, {
      provider,
      model: "test-model",
      idGenerator: () => "spawn-1",
    });

    const result = await spawnTool.execute(
      { task: "Inspect AGENTS.md", label: "Inspect" },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );
    await waitFor(() => rpc.requests.some((request) => request.method === "workspace.read_file"));

    expect(result.content).toBe("Subagent [Inspect] started (id: spawn-1). Running: 1/5");
    expect(result.metadata).toMatchObject({
      _background_event: true,
      _background_run_id: "spawn-1",
      _background_label: "Inspect",
      _background_status: "running",
    });
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "edit_file",
      "delete_file",
      "exec",
      "request_approval",
    ]);
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).not.toContain("task");
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).not.toContain("cron");
    expect(provider.requests[0]?.options?.tools?.map((tool) => tool.name)).not.toContain("spawn");
    expect(provider.requests[0]?.options?.model).toBe("test-model");
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Inspect AGENTS.md",
    });
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.read_file",
        params: { path: "AGENTS.md", format: "numbered_lines" },
      },
    ]);
  });

  test("resolves spawned subagent model at execution time", async () => {
    const rpc = new FakeRpcClient([]);
    const provider = new QueueProvider([
      { content: "configured model used", toolCalls: [], stopReason: "stop" },
    ]);
    const [spawnTool] = createNativeSpawnTools(rpc, {
      provider,
      model: async () => "deepseek-v4-flash",
      idGenerator: () => "spawn-2",
    });

    await spawnTool.execute(
      { task: "Use configured model", label: "Configured" },
      { runId: "run-2", traceId: "trace-2", sessionId: "desktop:chat-2" },
    );
    await waitFor(() => provider.requests.length > 0);

    expect(provider.requests[0]?.options?.model).toBe("deepseek-v4-flash");
  });
});

describe("createNativeRagTools", () => {
  test("creates a query_knowledge tool backed by knowledge.query", async () => {
    const rpc = new FakeRpcClient([
      {
        results: [
          {
            id: "doc-1",
            doc_name: "TS Agent Loop Design",
            file_path: "docs/ts-agent-loop.md",
            line_start: 12,
            line_end: 18,
            score: 0.91,
            content: "TS worker should proxy product integrations through Rust.",
          },
        ],
      },
    ]);
    const queryKnowledge = createNativeRagTools(rpc).find((tool) => tool.name === "query_knowledge");

    const result = await queryKnowledge?.execute(
      { query: "TS worker bridge", category: "docs", limit: 3 },
      { runId: "run-1", traceId: "trace-1", sessionId: "session-1" },
    );

    expect(queryKnowledge?.name).toBe("query_knowledge");
    expect(result?.content).toContain("## Knowledge Results");
    expect(result?.content).toContain("contextual evidence");
    expect(result?.content).toContain("[doc-1] TS Agent Loop Design");
    expect(result?.content).toContain("docs/ts-agent-loop.md:12-18");
    expect(result?.content).toContain("TS worker should proxy product integrations through Rust.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "knowledge.query",
        params: {
          session_id: "session-1",
          query: "TS worker bridge",
          category: "docs",
          limit: 3,
        },
      },
    ]);
  });

  test("creates knowledge document tools backed by native knowledge RPCs", async () => {
    const rpc = new FakeRpcClient([
      {
        document: {
          id: "doc-1",
          name: "Desktop Knowledge Notes",
          file_path: "knowledge/files/doc-1.md",
          file_type: "md",
          category: "desktop",
          tags: ["ts"],
          chunk_count: 1,
          created_at: "2026-06-12T03:45:00",
          content: "TS worker knowledge store should persist chunks.",
        },
      },
      {
        documents: [
          {
            id: "doc-1",
            name: "Desktop Knowledge Notes",
            file_path: "knowledge/files/doc-1.md",
            file_type: "md",
            category: "desktop",
            tags: ["ts"],
            chunk_count: 1,
            created_at: "2026-06-12T03:45:00",
            content: "TS worker knowledge store should persist chunks.",
          },
        ],
      },
      {
        document: { id: "doc-1", name: "Desktop Knowledge Notes" },
        content: "TS worker knowledge store should persist chunks.",
      },
      { deleted: true, doc_id: "doc-1" },
    ]);
    const tools = Object.fromEntries(createNativeRagTools(rpc).map((tool) => [tool.name, tool]));

    const addResult = await tools.add_document.execute(
      {
        name: "Desktop Knowledge Notes",
        content: "TS worker knowledge store should persist chunks.",
        category: "desktop",
        tags: "ts",
        file_type: "md",
        original_path: "docs/desktop-knowledge.md",
      },
      { runId: "run-1", traceId: "trace-1" },
    );
    const listResult = await tools.list_documents.execute(
      { category: "desktop", limit: 10 },
      { runId: "run-1", traceId: "trace-1" },
    );
    const getResult = await tools.get_document.execute(
      { doc_id: "doc-1" },
      { runId: "run-1", traceId: "trace-1" },
    );
    const deleteResult = await tools.delete_document.execute(
      { doc_id: "doc-1" },
      { runId: "run-1", traceId: "trace-1" },
    );

    expect(tools.add_document.requiresApproval).toBe(true);
    expect(tools.add_document.capabilities).toEqual(["knowledge.write"]);
    expect(tools.list_documents.readOnly).toBe(true);
    expect(tools.list_documents.capabilities).toEqual(["knowledge.read"]);
    expect(tools.get_document.capabilities).toEqual(["knowledge.read"]);
    expect(tools.delete_document.requiresApproval).toBe(true);
    expect(addResult.content).toContain("Successfully added document 'Desktop Knowledge Notes'");
    expect(listResult.content).toContain("## Knowledge Base Documents");
    expect(listResult.content).toContain("ID: doc-1");
    expect(getResult.content).toBe("## Document Content (ID: doc-1)\n\nTS worker knowledge store should persist chunks.");
    expect(deleteResult.content).toBe("Successfully deleted document doc-1 and all associated data.");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "knowledge.add_document",
        params: {
          name: "Desktop Knowledge Notes",
          content: "TS worker knowledge store should persist chunks.",
          category: "desktop",
          tags: ["ts"],
          file_type: "md",
          original_path: "docs/desktop-knowledge.md",
        },
      },
      {
        traceId: "trace-1",
        method: "knowledge.list_documents",
        params: { category: "desktop", limit: 10 },
      },
      {
        traceId: "trace-1",
        method: "knowledge.get_document",
        params: { doc_id: "doc-1" },
      },
      {
        traceId: "trace-1",
        method: "knowledge.delete_document",
        params: { doc_id: "doc-1" },
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

function taskPlan(options: { status: string; subtaskStatus: string; result?: string }) {
  return {
    id: "plan-1",
    title: "Backend migration",
    original_request: "Move backend runtime to TS",
    status: options.status,
    current_subtask_ids: options.subtaskStatus === "in_progress" ? ["a"] : [],
    context: { session_key: "desktop:chat-1" },
    subtasks: [
      {
        id: "a",
        title: "Inspect",
        description: "Inspect workspace instructions",
        status: options.subtaskStatus,
        dependencies: [],
        parallel_safe: true,
        result: options.result ?? null,
        error: null,
        started_at: null,
        completed_at: null,
        retry_count: 0,
        max_retries: 2,
      },
    ],
  };
}

async function waitFor(condition: () => boolean, attempts = 30): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
