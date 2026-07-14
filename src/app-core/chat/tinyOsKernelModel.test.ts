import { describe, expect, it } from "vitest";

import type { BackendAgentTurnItem, CanonicalTurnItemKind } from "./chatRunModel";
import {
  assertTinyOsMetricSupported,
  assertTinyOsResourceMutationReady,
  createTinyOsDerivedMetric,
  createTinyOsProcessId,
  mergeTinyOsProcessObservation,
  projectTinyOsKernel,
  type TinyOsProcess,
  type TinyOsResource,
} from "./tinyOsKernelModel";
import {
  createTinyOsBrowserCaptureSnapshot,
  createTinyOsTerminalProcessSnapshot,
  createTinyOsWorkspaceResourceSnapshot,
} from "./tinyOsNativeSnapshot";

function item(
  itemId: string,
  kind: CanonicalTurnItemKind,
  status: string,
  data: Record<string, unknown>,
  overrides: Partial<BackendAgentTurnItem> = {},
): BackendAgentTurnItem {
  return {
    schemaVersion: "tinybot.turn_item.v2",
    createdAt: `2026-07-14T00:00:0${overrides.sequence ?? 0}Z`,
    data: data as BackendAgentTurnItem["data"],
    itemId,
    kind,
    revision: 1,
    runId: "run-1",
    sequence: 0,
    sessionId: "session-1",
    status,
    turnId: "turn-1",
    ...overrides,
  };
}

function timeline(): BackendAgentTurnItem[] {
  return [
    item("user-1", "user_message", "completed", { content: "Build it", type: "user_message" }, { sequence: 1 }),
    item("tool-1", "tool_call", "running", {
      args: {},
      name: "workspace.read_file",
      result: null,
      status: "running",
      timing: {},
      toolCallId: "call-1",
      type: "tool_call",
    }, { sequence: 2, title: "Read workspace file" }),
    item("approval-1", "approval", "pending", {
      approvalId: "approval-1",
      status: "pending",
      toolCallId: "call-1",
      type: "approval",
    }, { sequence: 3 }),
    item("subagent-1", "subagent_lifecycle", "completed", {
      action: "completed",
      agentId: "agent-child",
      status: "completed",
      type: "subagent_lifecycle",
    }, { sequence: 4 }),
    item("answer-1", "assistant_message", "completed", {
      content: "Done",
      messageId: "message-1",
      modelCallId: "model-call-1",
      phase: "final_answer",
      type: "assistant_message",
    }, { sequence: 5 }),
  ];
}

describe("TinyOS simulation kernel", () => {
  it("derives stable process identities from canonical correlation", () => {
    const input = {
      itemId: "tool/1",
      kind: "tool_operation" as const,
      runId: "run:1",
      sessionId: "session 1",
      turnId: "turn-1",
    };
    const first = createTinyOsProcessId(input);
    const afterReload = createTinyOsProcessId(JSON.parse(JSON.stringify(input)));

    expect(afterReload).toBe(first);
    expect(first).toBe("tinyos:process:tool_operation:session%201:run%3A1:turn-1:tool%2F1");
    expect(() => createTinyOsProcessId({ kind: "agent_run", runId: " ", sessionId: "session-1" })).toThrow(/non-empty/i);
  });

  it("projects canonical run, turn, work lifecycle, and source-backed parents", () => {
    const snapshot = projectTinyOsKernel(timeline());
    const run = snapshot.processes.find((process) => process.kind === "agent_run");
    const turn = snapshot.processes.find((process) => process.kind === "agent_turn");
    const tool = snapshot.processes.find((process) => process.kind === "tool_operation");
    const approval = snapshot.processes.find((process) => process.kind === "user_input_wait");
    const subagent = snapshot.processes.find((process) => process.kind === "subagent");

    expect(snapshot).toMatchObject({
      cursor: { eventCount: 5, eventIndex: 4, mode: "live" },
      truth: "derived",
    });
    expect(run).toMatchObject({ state: "completed", provenance: { kind: "canonical_event", sourceId: "answer-1" } });
    expect(turn).toMatchObject({ parentProcessId: run?.id, state: "completed" });
    expect(tool).toMatchObject({ parentProcessId: turn?.id, state: "running" });
    expect(tool?.parentProcessId).not.toBe(tool?.id);
    expect(approval).toMatchObject({ parentProcessId: tool?.id, state: "waiting_for_user" });
    expect(subagent).toMatchObject({ parentProcessId: turn?.id, state: "completed" });
  });

  it("reconstructs the same identities after reload and at a History boundary", () => {
    const source = timeline();
    const reloaded = JSON.parse(JSON.stringify(source)) as BackendAgentTurnItem[];
    const live = projectTinyOsKernel(source);
    const liveAfterReload = projectTinyOsKernel(reloaded);
    const history = projectTinyOsKernel(reloaded, { itemId: "approval-1", mode: "history" });

    expect(liveAfterReload.processes.map((process) => process.id)).toEqual(live.processes.map((process) => process.id));
    expect(history.cursor).toMatchObject({
      boundary: { itemId: "approval-1", sequence: 3 },
      eventCount: 5,
      eventIndex: 2,
      mode: "history",
    });
    expect(history.processes.some((process) => process.kind === "subagent")).toBe(false);
    expect(history.processes.find((process) => process.kind === "agent_run")?.state).toBe("waiting_for_user");
    expect(() => projectTinyOsKernel(source, { itemId: "missing", mode: "history" })).toThrow(/boundary is unavailable/i);
  });

  it("uses the newest canonical item revision without changing its stable identity", () => {
    const original = timeline()[1];
    const completed = { ...original, revision: 2, status: "completed", updatedAt: "2026-07-14T00:00:06Z" };
    const snapshot = projectTinyOsKernel([original, completed]);
    const tool = snapshot.processes.find((process) => process.kind === "tool_operation");

    expect(tool).toMatchObject({
      provenance: { revision: 2, sourceId: "tool-1" },
      state: "completed",
    });
    expect(snapshot.processes.filter((process) => process.kind === "tool_operation")).toHaveLength(1);
  });

  it("projects only canonically evidenced resources and preserves missing revisions", () => {
    const resources = projectTinyOsKernel([
      item("file-1", "file_reference", "completed", {
        id: "ref-1",
        path: "src/main.ts",
        referenceKind: "modified",
        type: "file_reference",
      }, { sequence: 1 }),
      item("terminal-1", "tool_call", "completed", {
        args: {},
        name: "shell.execute",
        result: {
          artifacts: [
            { id: "capture-1", kind: "browser_snapshot", title: "Browser result" },
            { id: "report-1", kind: "markdown", title: "Report" },
          ],
        },
        status: "completed",
        timing: {},
        toolCallId: "call-terminal",
        type: "tool_call",
      }, { sequence: 2 }),
      item("memory-1", "tool_call", "completed", {
        args: {},
        name: "memory.recall",
        result: {},
        status: "completed",
        timing: {},
        toolCallId: "call-memory",
        type: "tool_call",
      }, { sequence: 3 }),
      item("plan-1", "plan_progress", "running", {
        completed: 0,
        id: "plan",
        steps: [],
        summary: "Planning",
        total: 1,
        type: "plan_progress",
      }, { sequence: 4 }),
    ]).resources;

    expect(resources.map((resource) => resource.kind)).toEqual([
      "file",
      "terminal_execution",
      "browser_capture",
      "artifact",
      "memory_result",
      "plan",
    ]);
    expect(resources.find((resource) => resource.kind === "file")).toMatchObject({
      path: "src/main.ts",
      provenance: { kind: "canonical_event", sourceId: "file-1" },
      relatedProcessIds: [expect.stringContaining("agent_turn")],
    });
    expect(resources.find((resource) => resource.kind === "file")).not.toHaveProperty("revision");
    expect(resources.find((resource) => resource.kind === "browser_capture")?.id).toContain("capture-1");
  });

  it("preserves native observations and exposes canonical/native discrepancies", () => {
    const canonicalFile = item("file-1", "file_reference", "completed", {
      id: "ref-1",
      path: "src/main.ts",
      referenceKind: "modified",
      revision: "canonical-1",
      type: "file_reference",
    }, { sequence: 1 });
    const canonicalTool = item("tool-1", "tool_call", "running", {
      args: {},
      name: "shell.execute",
      result: null,
      status: "running",
      timing: {},
      toolCallId: "call-1",
      type: "tool_call",
    }, { sequence: 2 });
    const metadata = { observedAt: "2026-07-14T00:00:03Z", revision: "native-2", sourceId: "native-query" };
    const snapshot = projectTinyOsKernel([canonicalFile, canonicalTool], { mode: "live" }, {
      nativeSnapshots: [
        createTinyOsWorkspaceResourceSnapshot({
          access: "read_write",
          kind: "workspace_resource",
          path: "src/main.ts",
          resourceKind: "file",
          workspaceKey: "workspace-1",
        }, metadata),
        createTinyOsTerminalProcessSnapshot({
          command: "npm test",
          kind: "terminal_process",
          nativeProcessId: "process-1",
          runId: "run-1",
          sessionId: "session-1",
          state: "completed",
          toolCallId: "call-1",
        }, metadata),
        createTinyOsBrowserCaptureSnapshot({
          captureId: "capture-native-1",
          kind: "browser_capture",
          realCapture: true,
          title: "Native capture",
        }, metadata),
      ],
    });

    expect(snapshot.resources.filter((resource) => resource.path === "src/main.ts")).toHaveLength(2);
    expect(snapshot.resources.find((resource) => resource.title === "Native capture")?.provenance.kind).toBe("real_capture");
    expect(snapshot.processes.find((process) => process.kind === "terminal_process")).toMatchObject({
      parentProcessId: snapshot.processes.find((process) => process.kind === "tool_operation")?.id,
      provenance: { kind: "native_query", sourceId: "native-query" },
      state: "completed",
    });
    expect(snapshot.discrepancies).toEqual([
      expect.objectContaining({
        canonical: expect.objectContaining({ value: "canonical-1" }),
        kind: "revision",
        native: expect.objectContaining({ value: "native-2" }),
      }),
      expect.objectContaining({
        canonical: expect.objectContaining({ value: "running" }),
        kind: "lifecycle",
        native: expect.objectContaining({ value: "completed" }),
      }),
    ]);
  });

  it("creates only auditable derived metrics", () => {
    expect(createTinyOsDerivedMetric({
      calculation: "UTF-8 byte length of retained stdout",
      id: "terminal-output-bytes",
      inputIds: ["chunk-1", "chunk-1", "chunk-2"],
      label: "Retained output",
      unit: "bytes",
      value: 128,
    })).toMatchObject({
      calculation: "UTF-8 byte length of retained stdout",
      inputIds: ["chunk-1", "chunk-2"],
      provenance: { kind: "derived_measurement" },
      value: 128,
    });
    expect(() => createTinyOsDerivedMetric({
      calculation: "Decorative estimate",
      id: "cpu",
      inputIds: [],
      label: "CPU",
      value: 42,
    })).toThrow(/input identity/i);
    expect(() => assertTinyOsMetricSupported({
      id: "cpu",
      label: "CPU",
      provenance: { kind: "local_presentation", sourceId: "widget" },
      value: 42,
    })).toThrow(/unsupported provenance/i);
  });

  it("requires writable revisioned resources before mutation", () => {
    const resource: TinyOsResource = {
      access: "read_write",
      id: "file-1",
      kind: "file",
      path: "src/main.ts",
      provenance: { kind: "native_query", sourceId: "workspace.read" },
      relatedProcessIds: [],
      title: "src/main.ts",
    };
    expect(() => assertTinyOsResourceMutationReady(resource)).toThrow(/base revision/i);
    expect(() => assertTinyOsResourceMutationReady({ ...resource, revision: "revision-1" })).not.toThrow();
  });

  it("rejects terminal process-state regression", () => {
    const process: TinyOsProcess = {
      correlation: { runId: "run-1", sessionId: "session-1" },
      id: "process-1",
      kind: "terminal_process",
      provenance: { kind: "native_query", sourceId: "shell.list" },
      state: "completed",
      title: "npm test",
    };
    expect(() => mergeTinyOsProcessObservation(process, { ...process, state: "running" })).toThrow(/terminal state/i);
    expect(() => projectTinyOsKernel([
      item("tool-1", "tool_call", "completed", {
        args: {}, name: "shell.execute", result: {}, status: "completed", timing: {}, toolCallId: "call-1", type: "tool_call",
      }, { revision: 1, sequence: 1 }),
      item("tool-1", "tool_call", "running", {
        args: {}, name: "shell.execute", result: {}, status: "running", timing: {}, toolCallId: "call-1", type: "tool_call",
      }, { revision: 2, sequence: 1 }),
    ])).toThrow(/terminal state/i);
  });

  it("handles empty and partial canonical input without inventing state", () => {
    expect(projectTinyOsKernel([])).toEqual({
      capabilities: [],
      cursor: { eventCount: 0, eventIndex: -1, mode: "live" },
      discrepancies: [],
      metrics: [],
      notifications: [],
      processes: [],
      resources: [],
      truth: "derived",
    });
    const partial = projectTinyOsKernel([
      item("tool-1", "tool_call", "unknown", {
        args: {}, name: "custom.tool", result: null, status: "unknown", timing: {}, toolCallId: "call-1", type: "tool_call",
      }, { createdAt: "", sequence: 1 }),
    ]);
    expect(partial.processes.find((process) => process.kind === "tool_operation")?.state).toBe("queued");
    expect(partial.cursor).not.toHaveProperty("wallClockTime");
    expect(partial.metrics).toEqual([]);
  });

  it("ignores an older out-of-order revision after a terminal observation", () => {
    const completed = item("tool-1", "tool_call", "completed", {
      args: {}, name: "custom.tool", result: {}, status: "completed", timing: {}, toolCallId: "call-1", type: "tool_call",
    }, { revision: 2, sequence: 1 });
    const olderRunning = { ...completed, revision: 1, status: "running" };
    const snapshot = projectTinyOsKernel([completed, olderRunning]);

    expect(snapshot.processes.find((process) => process.kind === "tool_operation")).toMatchObject({
      provenance: { revision: 2 },
      state: "completed",
    });
  });

  it("projects a large timeline deterministically", () => {
    const items = Array.from({ length: 2_000 }, (_, index) => item(
      `tool-${index}`,
      "tool_call",
      index % 2 ? "completed" : "running",
      {
        args: {},
        name: "custom.tool",
        result: {},
        status: index % 2 ? "completed" : "running",
        timing: {},
        toolCallId: `call-${index}`,
        type: "tool_call",
      },
      { sequence: index + 1 },
    ));
    const first = projectTinyOsKernel(items);
    const second = projectTinyOsKernel(JSON.parse(JSON.stringify(items)) as BackendAgentTurnItem[]);

    expect(first.processes).toHaveLength(2_002);
    expect(second.processes.map((process) => process.id)).toEqual(first.processes.map((process) => process.id));
    expect(first.cursor).toMatchObject({ eventCount: 2_000, eventIndex: 1_999 });
  });
});
