import { describe, expect, test } from "vitest";

import { DelegatedRunManager, DelegatedRunRegistry } from "./delegatedRun";
import { SubagentRuntime, type SubagentRunRequest } from "./subagentRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("DelegatedRunManager", () => {
  test("spawns a delegated run with parent linkage and conservative defaults", async () => {
    const started: SubagentRunRequest[] = [];
    const events: string[] = [];
    const gate = deferred<string>();
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-1",
      runner: async (request) => {
        started.push(request);
        return { status: "completed", result: await gate.promise };
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      emitEvent: (event) => events.push(event.eventName),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    const run = await manager.spawnAgent({
      taskName: "Review Desktop Approval",
      message: "Review the approval flow",
      label: "Approval reviewer",
    }, {
      runId: "parent-run",
      turnId: "turn-1",
      sessionKey: "WebSocket:chat-1",
      traceId: "trace-parent",
      model: "test-model",
      cwd: "D:/Code/py/tinybot",
    });

    expect(run).toMatchObject({
      delegateId: "delegate-1",
      childRunId: "delegate-1",
      taskName: "review_desktop_approval",
      agentPath: "/review_desktop_approval",
      parentRunId: "parent-run",
      parentTurnId: "turn-1",
      parentSessionKey: "WebSocket:chat-1",
      label: "Approval reviewer",
      task: "Review the approval flow",
      status: "running",
      model: "test-model",
      permissionProfile: "read_only",
      approvalPolicy: "ask_on_sensitive_action",
      cwd: "D:/Code/py/tinybot",
      forkTurns: "none",
      traceRef: "trace-parent",
      createdAt: "2026-06-27T12:00:00.000Z",
      updatedAt: "2026-06-27T12:00:00.000Z",
    });
    await waitFor(() => started.length === 1);
    expect(started[0]).toMatchObject({
      id: "delegate-1",
      task: "Review the approval flow",
      label: "Approval reviewer",
      sessionKey: "WebSocket:chat-1",
      metadata: {
        traceId: "trace-parent",
        parentRunId: "parent-run",
        parentTurnId: "turn-1",
        origin: "delegated_run",
        taskName: "review_desktop_approval",
        delegatedContextPack: {
          kind: "delegated_context_pack",
          taskName: "review_desktop_approval",
          message: "Review the approval flow",
          parentRunId: "parent-run",
          parentTurnId: "turn-1",
          parentSessionKey: "WebSocket:chat-1",
          forkTurns: "none",
          runtimePolicy: {
            model: "test-model",
            permissionProfile: "read_only",
            approvalPolicy: "ask_on_sensitive_action",
            cwd: "D:/Code/py/tinybot",
          },
        },
      },
    });

    const waitPromise = manager.waitAgent(["delegate-1"], { timeoutMs: 1000 });
    gate.resolve("approval review complete");
    await expect(waitPromise).resolves.toMatchObject({
      active: [],
      timedOut: [],
      runs: [{
        delegateId: "delegate-1",
        status: "completed",
        result: {
          status: "completed",
          summary: "approval review complete",
        },
        trace: {
          steps: [expect.objectContaining({
            kind: "message",
            status: "completed",
            summary: "approval review complete",
            title: "Final answer",
          })],
        },
      }],
    });
    expect(events).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.trace.updated",
      "agent.delegate.completed",
    ]);
  });

  test("reports queued delegated runs and timed out waits", async () => {
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `delegate-${index += 1}`;
      })(),
      runner: async () => new Promise(() => {}),
    });
    const manager = new DelegatedRunManager({ runtime });

    const first = await manager.spawnAgent(
      { taskName: "First", message: "First task" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    );
    const second = await manager.spawnAgent(
      { taskName: "Second", message: "Second task" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    );

    expect(first).toMatchObject({ delegateId: "delegate-1", status: "running", queued: false });
    expect(second).toMatchObject({ delegateId: "delegate-2", status: "queued", queued: true });
    await expect(manager.waitAgent(["delegate-1", "delegate-2"], { timeoutMs: 0 })).resolves.toMatchObject({
      active: ["delegate-1", "delegate-2"],
      timedOut: ["delegate-1", "delegate-2"],
    });
  });

  test("limits active delegated runs per parent run", async () => {
    const runtime = new SubagentRuntime({
      maxConcurrent: 20,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `delegate-${index += 1}`;
      })(),
      runner: async () => new Promise(() => {}),
    });
    const manager = new DelegatedRunManager({ runtime });

    for (let index = 0; index < 8; index += 1) {
      await manager.spawnAgent(
        { taskName: `Task ${index}`, message: `Task ${index}` },
        { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
      );
    }

    await expect(manager.spawnAgent(
      { taskName: "Overflow", message: "Overflow task" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    )).rejects.toThrow("parent run parent-run already has 8 active delegated runs");
  });

  test("allows new delegated runs after earlier parent runs complete", async () => {
    const runtime = new SubagentRuntime({
      maxConcurrent: 20,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `delegate-${index += 1}`;
      })(),
      runner: async () => ({ status: "completed", result: "done" }),
    });
    const manager = new DelegatedRunManager({ runtime });

    for (let index = 0; index < 9; index += 1) {
      await manager.spawnAgent(
        { taskName: `Task ${index}`, message: `Task ${index}` },
        { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
      );
      await manager.waitAgent([`delegate-${index + 1}`], { timeoutMs: 1000 });
    }

    expect(manager.listAgents({ parentRunId: "parent-run" }).filter((run) => run.status === "completed")).toHaveLength(9);
  });

  test("lists, records messages, and closes delegated runs", async () => {
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-1",
      runner: async () => new Promise(() => {}),
    });
    const registry = new DelegatedRunRegistry();
    const events: string[] = [];
    const manager = new DelegatedRunManager({
      runtime,
      registry,
      emitEvent: (event) => events.push(event.eventName),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Reviewer", message: "Review code", forkTurns: "3", permissionProfile: "read_only" },
      {
        runId: "parent-run",
        sessionKey: "WebSocket:chat-1",
        permissionProfile: "read_only",
      },
    );

    expect(manager.listAgents({ parentSessionKey: "WebSocket:chat-1" })).toHaveLength(1);
    expect(manager.sendMessage("delegate-1", "Please focus on tests", { triggerFollowup: true })).toMatchObject({
      messages: [{
        id: "msg-1",
        message: "Please focus on tests",
        triggerFollowup: true,
        createdAt: "2026-06-27T12:00:00.000Z",
      }],
    });
    expect(manager.closeAgent("delegate-1")).toMatchObject({
      delegateId: "delegate-1",
      status: "closed",
      result: {
        status: "closed",
        summary: "Delegated run closed.",
      },
    });
    expect(events).toContain("agent.delegate.message_queued");
    expect(events).toContain("agent.delegate.closed");
  });

  test("records child trace steps and emits trace update events", async () => {
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-1",
      runner: async () => new Promise(() => {}),
    });
    const registry = new DelegatedRunRegistry();
    const events: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const manager = new DelegatedRunManager({
      runtime,
      registry,
      emitEvent: (event) => events.push({ eventName: event.eventName, payload: event.payload }),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Greeter", message: "Say hello" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    );

    const updated = manager.appendTraceStep("delegate-1", {
      id: "trace-step-1",
      kind: "message",
      status: "completed",
      title: "Assistant message",
      summary: "你好",
      createdAt: "2026-06-27T12:00:01.000Z",
      updatedAt: "2026-06-27T12:00:01.000Z",
    });

    expect(updated.trace).toMatchObject({
      delegateId: "delegate-1",
      childRunId: "delegate-1",
      parentRunId: "parent-run",
      parentSessionKey: "WebSocket:chat-1",
      status: "running",
      steps: [{
        id: "trace-step-1",
        kind: "message",
        status: "completed",
        title: "Assistant message",
        summary: "你好",
      }],
    });
    expect(events.at(-1)).toMatchObject({
      eventName: "agent.delegate.trace.updated",
      payload: {
        delegate_id: "delegate-1",
        child_run_id: "delegate-1",
        trace: {
          steps: [{
            id: "trace-step-1",
            summary: "你好",
          }],
        },
      },
    });
  });

  test("rejects silent permission expansion and invalid fork policies", async () => {
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      runner: async () => new Promise(() => {}),
    });
    const manager = new DelegatedRunManager({ runtime });

    await expect(manager.spawnAgent(
      { taskName: "Writer", message: "Write files", permissionProfile: "workspace_write" },
      { runId: "parent-run", permissionProfile: "read_only" },
    )).rejects.toThrow("exceeds parent profile");

    await expect(manager.spawnAgent(
      { taskName: "Bad fork", message: "Review", forkTurns: "0" as `${number}` },
      { runId: "parent-run", permissionProfile: "read_only" },
    )).rejects.toThrow("forkTurns must be none, all, or a positive integer string");
  });

  test("records full-history fork policy in the delegated context pack", async () => {
    const started: SubagentRunRequest[] = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-all",
      runner: async (request) => {
        started.push(request);
        return new Promise(() => {});
      },
    });
    const manager = new DelegatedRunManager({ runtime });

    const run = await manager.spawnAgent(
      { taskName: "Full context", message: "Use all available context", forkTurns: "all" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    );
    await waitFor(() => started.length === 1);

    expect(run.forkTurns).toBe("all");
    expect(started[0]?.metadata).toMatchObject({
      delegatedContextPack: {
        forkTurns: "all",
        message: "Use all available context",
      },
    });
  });
});

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
