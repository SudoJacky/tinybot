import { describe, expect, test } from "vitest";

import { NativeBackgroundRegistryBridge } from "./backgroundRegistryBridge";

class FakeRpc {
  readonly requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  response: unknown = {};

  async request(traceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    return this.response;
  }
}

describe("NativeBackgroundRegistryBridge", () => {
  test("maps upsert and complete to native background registry RPC methods", async () => {
    const rpc = new FakeRpc();
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    await bridge.upsertRun({
      id: "subagent-1",
      kind: "subagent",
      source: "task",
      status: "running",
      label: "Inspect",
      sessionKey: "desktop:chat-1",
      planId: "plan-1",
      subtaskId: "a",
      startedAtMs: 1000,
      updatedAtMs: 1000,
      metadata: { traceId: "trace-1" },
    }, "trace-1");
    await bridge.upsertRun({
      id: "subagent-1",
      kind: "subagent",
      source: "task",
      status: "awaiting_approval",
      label: "Inspect",
      sessionKey: "desktop:chat-1",
      startedAtMs: 1000,
      updatedAtMs: 1500,
      result: "Waiting for approval.",
      metadata: { traceId: "trace-1", stopReason: "awaiting_approval" },
    }, "trace-1");
    await bridge.completeRun({
      runId: "subagent-1",
      status: "completed",
      completedAtMs: 2000,
      result: "done",
      error: null,
    }, "trace-1");

    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "background.run.upsert",
        params: {
          run: {
            id: "subagent-1",
            kind: "subagent",
            source: "task",
            status: "running",
            label: "Inspect",
            sessionKey: "desktop:chat-1",
            planId: "plan-1",
            subtaskId: "a",
            startedAtMs: 1000,
            updatedAtMs: 1000,
            metadata: { traceId: "trace-1" },
          },
        },
      },
      {
        traceId: "trace-1",
        method: "background.run.upsert",
        params: {
          run: {
            id: "subagent-1",
            kind: "subagent",
            source: "task",
            status: "awaiting_approval",
            label: "Inspect",
            sessionKey: "desktop:chat-1",
            startedAtMs: 1000,
            updatedAtMs: 1500,
            result: "Waiting for approval.",
            metadata: { traceId: "trace-1", stopReason: "awaiting_approval" },
          },
        },
      },
      {
        traceId: "trace-1",
        method: "background.run.complete",
        params: {
          run_id: "subagent-1",
          status: "completed",
          completedAtMs: 2000,
          result: "done",
          error: null,
        },
      },
    ]);
  });

  test("lists persisted native background runs", async () => {
    const rpc = new FakeRpc();
    rpc.response = {
      runs: [{
        id: "delegate-restored",
        kind: "subagent",
        source: "subagent",
        status: "completed",
        label: "Say hello",
        sessionKey: "WebSocket:chat-1",
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: 2000,
        result: "你好",
        error: null,
        metadata: {
          parentRunId: "parent-run",
          taskName: "say_hello",
          traceId: "trace-restored",
        },
      }],
    };
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    await expect(bridge.listRuns("trace-list-runs")).resolves.toEqual([{
      id: "delegate-restored",
      kind: "subagent",
      source: "subagent",
      status: "completed",
      label: "Say hello",
      sessionKey: "WebSocket:chat-1",
      startedAtMs: 1000,
      updatedAtMs: 2000,
      completedAtMs: 2000,
      result: "你好",
      error: null,
      metadata: {
        parentRunId: "parent-run",
        taskName: "say_hello",
        traceId: "trace-restored",
      },
    }]);
    expect(rpc.requests.at(-1)).toEqual({
      traceId: "trace-list-runs",
      method: "background.run.list",
      params: {},
    });
  });

  test("maps trace journal append and list to native background RPC methods", async () => {
    const rpc = new FakeRpc();
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    await bridge.appendTraceEvent({
      eventId: "evt-1",
      eventType: "agent.delegate.started",
      sessionKey: "WebSocket:chat-1",
      turnId: "turn-1",
      delegateId: "delegate-1",
      childRunId: "delegate-1",
      traceRef: "trace-delegate-1",
      sequence: 1,
      createdAt: "2026-06-28T00:00:00.000Z",
      payload: { status: "running" },
    }, "trace-delegate-1");
    await bridge.listTraceEvents({ sessionKey: "WebSocket:chat-1", delegateId: "delegate-1" }, "trace-delegate-1");

    expect(rpc.requests.slice(-2)).toEqual([
      {
        traceId: "trace-delegate-1",
        method: "background.trace.append",
        params: {
          event: {
            eventId: "evt-1",
            eventType: "agent.delegate.started",
            sessionKey: "WebSocket:chat-1",
            turnId: "turn-1",
            delegateId: "delegate-1",
            childRunId: "delegate-1",
            traceRef: "trace-delegate-1",
            sequence: 1,
            createdAt: "2026-06-28T00:00:00.000Z",
            payload: { status: "running" },
          },
        },
      },
      {
        traceId: "trace-delegate-1",
        method: "background.trace.list",
        params: {
          filter: {
            sessionKey: "WebSocket:chat-1",
            delegateId: "delegate-1",
          },
        },
      },
    ]);
  });

  test("maps delegate trace reconstruction to native background RPC method", async () => {
    const rpc = new FakeRpc();
    rpc.response = {
      trace: {
        sessionKey: "WebSocket:chat-1",
        delegateId: "delegate-1",
        childRunId: "child-1",
        traceRef: "trace-delegate-1",
        status: "completed",
        finalOutput: "Done",
        events: [
          {
            eventId: "event-1",
            eventType: "child.message.completed",
            sessionKey: "WebSocket:chat-1",
            turnId: "turn-1",
            delegateId: "delegate-1",
            childRunId: "child-1",
            traceRef: "trace-delegate-1",
            sequence: 1,
            createdAt: "2026-06-28T00:00:00.000Z",
            payload: { resultPreview: "Done" },
          },
        ],
        approvals: [{ approvalId: "approval-1", status: "approved" }],
        artifacts: [{ artifactId: "artifact-1", kind: "diff" }],
      },
    };
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    const trace = await bridge.getDelegateTrace({
      sessionKey: "WebSocket:chat-1",
      delegateId: "delegate-1",
    }, "trace-delegate-1");

    expect(trace).toMatchObject({
      sessionKey: "WebSocket:chat-1",
      delegateId: "delegate-1",
      childRunId: "child-1",
      traceRef: "trace-delegate-1",
      status: "completed",
      finalOutput: "Done",
      approvals: [{ approvalId: "approval-1", status: "approved" }],
      artifacts: [{ artifactId: "artifact-1", kind: "diff" }],
    });
    expect(trace?.events).toHaveLength(1);
    expect(rpc.requests.at(-1)).toEqual({
      traceId: "trace-delegate-1",
      method: "background.trace.get_delegate_trace",
      params: {
        filter: {
          sessionKey: "WebSocket:chat-1",
          delegateId: "delegate-1",
        },
      },
    });
  });

  test("maps artifact retrieval to native background RPC method", async () => {
    const rpc = new FakeRpc();
    rpc.response = {
      artifact: {
        artifactId: "artifact-1",
        kind: "diff",
        title: "Patch",
        content: "--- a/file\n+++ b/file",
      },
    };
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    const artifact = await bridge.getArtifact({
      sessionKey: "WebSocket:chat-1",
      delegateId: "delegate-1",
      artifactId: "artifact-1",
    }, "trace-delegate-1");

    expect(artifact).toEqual({
      artifactId: "artifact-1",
      kind: "diff",
      title: "Patch",
      content: "--- a/file\n+++ b/file",
    });
    expect(rpc.requests.at(-1)).toEqual({
      traceId: "trace-delegate-1",
      method: "background.trace.get_artifact",
      params: {
        filter: {
          sessionKey: "WebSocket:chat-1",
          delegateId: "delegate-1",
          artifactId: "artifact-1",
        },
      },
    });
  });
});
