import { describe, expect, test } from "vitest";

import type { BackgroundTraceEvent } from "./backgroundRegistryBridge";
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
    const traceEvents: BackgroundTraceEvent[] = [];
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
      traceJournal: {
        appendTraceEvent: async (event) => {
          traceEvents.push(event);
        },
        listTraceEvents: async () => traceEvents,
      },
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
      cwd: "D:/Code/tinybot/tinybot",
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
      cwd: "D:/Code/tinybot/tinybot",
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
            cwd: "D:/Code/tinybot/tinybot",
          },
        },
      },
    });

    const waitPromise = manager.waitAgent(["delegate-1"], { timeoutMs: 1000 });
    gate.resolve("approval review complete");
    await expect(waitPromise).resolves.toMatchObject({
      active: [],
      awaitingApproval: [],
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
    await waitFor(() => traceEvents.length === events.length + 1);
    const agentTraceEvents = traceEvents.filter((event) => event.eventType.startsWith("agent.delegate."));
    const childTraceEvents = traceEvents.filter((event) => event.eventType.startsWith("child."));
    expect(agentTraceEvents.map((event) => event.eventType)).toEqual(events);
    expect(agentTraceEvents).toEqual([
      expect.objectContaining({
        eventId: "delegate-1:1:agent.delegate.started",
        sessionKey: "WebSocket:chat-1",
        turnId: "turn-1",
        delegateId: "delegate-1",
        childRunId: "delegate-1",
        traceRef: "trace-parent",
        sequence: 1,
        payload: expect.objectContaining({
          task_name: "review_desktop_approval",
          status: "running",
        }),
      }),
      expect.objectContaining({
        eventId: "delegate-1:2:agent.delegate.running",
        sequence: 2,
      }),
      expect.objectContaining({
        eventId: "delegate-1:3:agent.delegate.trace.updated",
        sequence: 3,
        payload: expect.objectContaining({
          trace: expect.objectContaining({
            status: "completed",
          }),
        }),
      }),
      expect.objectContaining({
        eventId: "delegate-1:5:agent.delegate.completed",
        sequence: 5,
        payload: expect.objectContaining({
          final_output: "approval review complete",
        }),
      }),
    ]);
    expect(childTraceEvents).toEqual([
      expect.objectContaining({
        childRunId: "delegate-1",
        childStepId: "final:delegate-1",
        delegateId: "delegate-1",
        eventId: "delegate-1:4:child.message.completed:final:delegate-1",
        eventType: "child.message.completed",
        sequence: 4,
        payload: expect.objectContaining({
          child_step_id: "final:delegate-1",
          step_kind: "message",
          step_status: "completed",
          summary: "approval review complete",
        }),
      }),
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
      awaitingApproval: [],
      timedOut: ["delegate-1", "delegate-2"],
    });
  });

  test("followup_task triggers a new child turn on the same delegated run", async () => {
    const started: SubagentRunRequest[] = [];
    const completions = ["initial complete", "follow-up complete"];
    const events: string[] = [];
    const traceEvents: BackgroundTraceEvent[] = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-followup",
      runner: async (request) => {
        started.push(request);
        return { status: "completed", result: completions.shift() ?? "unexpected" };
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      traceJournal: {
        appendTraceEvent: async (event) => {
          traceEvents.push(event);
        },
        listTraceEvents: async () => traceEvents,
      },
      emitEvent: (event) => events.push(event.eventName),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Investigate", message: "Initial task", forkTurns: "1" },
      {
        runId: "parent-run",
        sessionKey: "WebSocket:chat-1",
        traceId: "trace-parent",
        parentMessages: [
          { role: "user", content: "Parent request" },
          { role: "assistant", content: "Parent final answer" },
        ],
      },
    );
    await manager.waitAgent(["delegate-followup"], { timeoutMs: 1000 });

    const followup = await manager.followupTask("delegate-followup", "Check one more file");
    expect(followup).toMatchObject({
      delegateId: "delegate-followup",
      status: "running",
      messages: [expect.objectContaining({
        message: "Check one more file",
        triggerFollowup: true,
      })],
    });
    await expect(manager.waitAgent(["delegate-followup"], { timeoutMs: 1000 })).resolves.toMatchObject({
      active: [],
      timedOut: [],
      runs: [{
        delegateId: "delegate-followup",
        status: "completed",
        result: {
          status: "completed",
          summary: "follow-up complete",
        },
      }],
    });
    expect(started.map((request) => ({ id: request.id, task: request.task, origin: request.metadata?.origin }))).toEqual([
      { id: "delegate-followup", task: "Initial task", origin: "delegated_run" },
      { id: "delegate-followup", task: "Check one more file", origin: "delegated_followup" },
    ]);
    expect(started[1]?.metadata?.delegatedContextPack).toMatchObject({
      message: "Check one more file",
      forkTurns: "1",
      forkedMessages: [
        { role: "user", content: "Parent request" },
        { role: "assistant", content: "Parent final answer" },
      ],
    });
    expect(events).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.trace.updated",
      "agent.delegate.completed",
      "agent.delegate.message_queued",
      "agent.delegate.running",
      "agent.delegate.trace.updated",
      "agent.delegate.completed",
    ]);
    await waitFor(() => traceEvents.filter((event) => event.eventType === "child.message.completed").length === 2);
    expect(traceEvents.filter((event) => event.eventType === "child.message.completed")).toEqual([
      expect.objectContaining({
        childStepId: "final:delegate-followup",
        payload: expect.objectContaining({
          summary: "initial complete",
        }),
      }),
      expect.objectContaining({
        childStepId: "final:delegate-followup",
        payload: expect.objectContaining({
          summary: "follow-up complete",
        }),
      }),
    ]);
  });

  test("interrupts an active delegated run without letting abort completion overwrite cancellation", async () => {
    const events: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-interrupt",
      runner: async (request) => new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve({
          status: "failed",
          result: "Subagent cancelled.",
          error: "Subagent cancelled.",
        }), { once: true });
      }),
    });
    const manager = new DelegatedRunManager({
      runtime,
      emitEvent: (event) => events.push({ eventName: event.eventName, payload: event.payload }),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Long review", message: "Keep reviewing" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1" },
    );

    const interrupted = await manager.interruptAgent("delegate-interrupt");
    expect(interrupted).toMatchObject({
      delegateId: "delegate-interrupt",
      status: "cancelled",
      result: {
        status: "cancelled",
        summary: "Delegated run interrupted.",
      },
      trace: {
        steps: [expect.objectContaining({
          kind: "error",
          status: "cancelled",
          title: "Interrupted",
        })],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(manager.waitAgent(["delegate-interrupt"], { timeoutMs: 1000 })).resolves.toMatchObject({
      active: [],
      timedOut: [],
      runs: [{
        delegateId: "delegate-interrupt",
        status: "cancelled",
        result: {
          status: "cancelled",
          summary: "Delegated run interrupted.",
        },
      }],
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.trace.updated",
      "agent.delegate.interrupted",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      delegateId: "delegate-interrupt",
      status: "cancelled",
      latest_activity: "Delegated run interrupted.",
    });
  });

  test("keeps awaiting approval delegated runs out of failed completions", async () => {
    const events: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-approval",
      runner: async () => ({
        status: "awaiting_approval",
        result: "Waiting for approval.",
        metadata: {
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          _delegate_child_run_id: "delegate-approval",
          _delegate_child_tool_call_id: "call-write",
          _delegate_child_tool_name: "write_file",
          _delegate_operation_preview: "write_file path=\"notes.md\"",
        },
      }),
    });
    const manager = new DelegatedRunManager({
      runtime,
      emitEvent: (event) => events.push({ eventName: event.eventName, payload: event.payload }),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Write notes", message: "Write notes", permissionProfile: "workspace_write" },
      { runId: "parent-run", sessionKey: "WebSocket:chat-1", permissionProfile: "workspace_write" },
    );
    const wait = await manager.waitAgent(["delegate-approval"], { timeoutMs: 1000 });

    expect(wait).toMatchObject({
      active: [],
      awaitingApproval: ["delegate-approval"],
      timedOut: [],
      runs: [{
        delegateId: "delegate-approval",
        status: "awaiting_approval",
        approvalState: {
          approvalId: "approval-1",
          childToolCallId: "call-write",
          toolName: "write_file",
          operationPreview: "write_file path=\"notes.md\"",
        },
      }],
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.awaiting_approval",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      approvalId: "approval-1",
      status: "blocked",
      toolName: "write_file",
    });
  });

  test("records a resolved child approval before completing an awaiting delegated run", async () => {
    let complete!: NonNullable<SubagentRunRequest["onComplete"]>;
    const events: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const traceEvents: BackgroundTraceEvent[] = [];
    const manager = new DelegatedRunManager({
      runtime: {
        spawn: async (request) => {
          complete = request.onComplete!;
          return {
            id: "delegate-resume",
            label: request.label,
            message: "started",
            queued: false,
            queuedCount: 0,
            runningCount: 1,
          };
        },
        runExisting: async () => {
          throw new Error("not used");
        },
      },
      traceJournal: {
        appendTraceEvent: async (event) => {
          traceEvents.push(event);
        },
        listTraceEvents: async () => traceEvents,
      },
      emitEvent: (event) => events.push({ eventName: event.eventName, payload: event.payload }),
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Write notes", message: "Write notes", permissionProfile: "workspace_write" },
      { runId: "parent-run", turnId: "turn-1", sessionKey: "WebSocket:chat-1", traceId: "trace-parent", permissionProfile: "workspace_write" },
    );
    await complete({
      id: "delegate-resume",
      status: "awaiting_approval",
      result: "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        _delegate_child_run_id: "delegate-resume",
        _delegate_child_tool_call_id: "call-write",
        _delegate_child_tool_name: "write_file",
      },
    });
    await complete({
      id: "delegate-resume",
      status: "completed",
      result: "child completed after approval",
    });

    const wait = await manager.waitAgent(["delegate-resume"], { timeoutMs: 1000 });
    expect(wait.runs[0]).toMatchObject({
      status: "completed",
      approvalState: {
        approvalId: "approval-1",
        status: "approved",
      },
      trace: {
        approvals: [expect.objectContaining({
          approvalId: "approval-1",
          status: "approved",
        })],
        steps: expect.arrayContaining([
          expect.objectContaining({
            approvalId: "approval-1",
            kind: "approval",
            status: "completed",
            title: "write_file approval resolved",
          }),
          expect.objectContaining({
            kind: "message",
            status: "completed",
            summary: "child completed after approval",
          }),
        ]),
      },
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.awaiting_approval",
      "agent.delegate.trace.updated",
      "agent.delegate.trace.updated",
      "agent.delegate.completed",
    ]);
    await waitFor(() => traceEvents.some((event) => event.eventType === "child.approval.resolved"));
    expect(traceEvents).toContainEqual(expect.objectContaining({
      childStepId: "approval:approval-1",
      eventType: "child.approval.resolved",
      payload: expect.objectContaining({
        approval_id: "approval-1",
        step_kind: "approval",
        step_status: "completed",
      }),
    }));
  });

  test("records a denied child approval before completing an awaiting delegated run", async () => {
    let complete!: NonNullable<SubagentRunRequest["onComplete"]>;
    const traceEvents: BackgroundTraceEvent[] = [];
    const manager = new DelegatedRunManager({
      runtime: {
        spawn: async (request) => {
          complete = request.onComplete!;
          return {
            id: "delegate-denied",
            label: request.label,
            message: "started",
            queued: false,
            queuedCount: 0,
            runningCount: 1,
          };
        },
        runExisting: async () => {
          throw new Error("not used");
        },
      },
      traceJournal: {
        appendTraceEvent: async (event) => {
          traceEvents.push(event);
        },
        listTraceEvents: async () => traceEvents,
      },
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Write notes", message: "Write notes", permissionProfile: "workspace_write" },
      { runId: "parent-run", turnId: "turn-1", sessionKey: "WebSocket:chat-1", traceId: "trace-parent", permissionProfile: "workspace_write" },
    );
    await complete({
      id: "delegate-denied",
      status: "awaiting_approval",
      result: "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        _delegate_child_run_id: "delegate-denied",
        _delegate_child_tool_call_id: "call-write",
        _delegate_child_tool_name: "write_file",
      },
    });
    await complete({
      id: "delegate-denied",
      status: "completed",
      result: "child handled denied approval",
      metadata: {
        approvalId: "approval-1",
        approvalStatus: "denied",
        approved: false,
      },
    });

    const wait = await manager.waitAgent(["delegate-denied"], { timeoutMs: 1000 });
    expect(wait.runs[0]).toMatchObject({
      status: "completed",
      approvalState: {
        approvalId: "approval-1",
        status: "denied",
      },
      trace: {
        approvals: [expect.objectContaining({
          approvalId: "approval-1",
          status: "denied",
        })],
        steps: expect.arrayContaining([
          expect.objectContaining({
            approvalId: "approval-1",
            kind: "approval",
            status: "completed",
            summary: "Denied: approval-1",
            resultPreview: "Denied.",
          }),
        ]),
      },
    });
    await waitFor(() => traceEvents.some((event) => event.eventType === "child.approval.resolved"));
    expect(traceEvents).toContainEqual(expect.objectContaining({
      childStepId: "approval:approval-1",
      eventType: "child.approval.resolved",
      payload: expect.objectContaining({
        approval_id: "approval-1",
        step: expect.objectContaining({
          approvalId: "approval-1",
          resultPreview: "Denied.",
          summary: "Denied: approval-1",
        }),
      }),
    }));
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

    expect((await manager.listAgents({ parentRunId: "parent-run" })).filter((run) => run.status === "completed")).toHaveLength(9);
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

    await expect(manager.listAgents({ parentSessionKey: "WebSocket:chat-1" })).resolves.toHaveLength(1);
    await expect(manager.sendMessage("delegate-1", "Please focus on tests", { triggerFollowup: true })).resolves.toMatchObject({
      messages: [{
        id: "msg-1",
        message: "Please focus on tests",
        triggerFollowup: true,
        createdAt: "2026-06-27T12:00:00.000Z",
      }],
    });
    await expect(manager.closeAgent("delegate-1")).resolves.toMatchObject({
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

  test("persists child tool argument deltas separately from tool lifecycle events", async () => {
    const traceEvents: BackgroundTraceEvent[] = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-args",
      runner: async () => new Promise(() => {}),
    });
    const manager = new DelegatedRunManager({
      runtime,
      traceJournal: {
        appendTraceEvent: async (event) => {
          traceEvents.push(event);
        },
        listTraceEvents: async () => traceEvents,
      },
      now: () => "2026-06-27T12:00:00.000Z",
    });

    await manager.spawnAgent(
      { taskName: "Inspect args", message: "Inspect arguments" },
      { runId: "parent-run", turnId: "turn-1", sessionKey: "WebSocket:chat-1", traceId: "trace-parent" },
    );

    manager.appendTraceStep("delegate-args", {
      argsPreview: "{\"path\":\"README.md\"}",
      createdAt: "2026-06-27T12:00:01.000Z",
      id: "tool-read-1",
      kind: "tool_call",
      status: "running",
      summary: "Reading README.md",
      title: "read_file",
      toolCallId: "call-read-1",
      toolName: "read_file",
      updatedAt: "2026-06-27T12:00:01.000Z",
    });

    await waitFor(() => traceEvents.some((event) => event.eventType === "child.tool.arguments.delta"));

    expect(traceEvents.map((event) => event.eventType)).toEqual([
      "agent.delegate.started",
      "agent.delegate.running",
      "agent.delegate.trace.updated",
      "child.tool.started",
      "child.tool.arguments.delta",
    ]);
    expect(traceEvents.at(-1)).toMatchObject({
      childStepId: "tool-read-1",
      eventType: "child.tool.arguments.delta",
      payload: expect.objectContaining({
        args_preview: "{\"path\":\"README.md\"}",
        tool_call_id: "call-read-1",
        tool_name: "read_file",
      }),
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

  test("forks only sanitized recent parent turns into the delegated context pack", async () => {
    const started: SubagentRunRequest[] = [];
    const runtime = new SubagentRuntime({
      timeoutMs: 1000,
      idGenerator: () => "delegate-forked",
      runner: async (request) => {
        started.push(request);
        return new Promise(() => {});
      },
    });
    const manager = new DelegatedRunManager({ runtime });

    await manager.spawnAgent(
      { taskName: "Recent context", message: "Use recent parent context", forkTurns: "2" },
      {
        runId: "parent-run",
        sessionKey: "WebSocket:chat-1",
        parentMessages: [
          { role: "system", content: "System rules" },
          { role: "user", content: "Old user request" },
          { role: "assistant", content: "Old final answer" },
          { role: "tool", name: "read_file", toolCallId: "tool-old", content: "Old tool output" },
          { role: "user", content: "Recent user request" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
          },
          { role: "tool", name: "read_file", toolCallId: "call-1", content: "Recent tool output" },
          { role: "assistant", content: "Recent final answer", reasoningContent: "hidden reasoning" },
          { role: "user", content: "Current user request" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-spawn", name: "spawn_agent", argumentsJson: "{}" }],
          },
        ],
      },
    );
    await waitFor(() => started.length === 1);

    const delegatedContextPack = started[0]?.metadata?.delegatedContextPack as {
      forkedMessages?: Array<{ role: string; content: string; reasoningContent?: string; toolCalls?: unknown[] }>;
    } | undefined;
    expect(delegatedContextPack?.forkedMessages).toEqual([
      { role: "user", content: "Recent user request" },
      { role: "assistant", content: "Recent final answer" },
      { role: "user", content: "Current user request" },
    ]);
    expect(JSON.stringify(delegatedContextPack?.forkedMessages)).not.toContain("tool");
    expect(JSON.stringify(delegatedContextPack?.forkedMessages)).not.toContain("hidden reasoning");
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
