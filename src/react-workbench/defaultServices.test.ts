// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDesktopAppServices } from "./defaultServices";
import type { ChatEvent } from "./services";
import { createDesktopStopCommand, createDesktopTurnSubmitCommand } from "../app-core/chat/desktopCommand";
import { createTinyOsApprovalResolveCommand } from "../app-core/chat/tinyOsCommandGateway";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("../app-core/gateway/desktopGatewayStartup", () => ({ ensureGatewayReady: vi.fn(async () => undefined) }));

const thread = {
  threadId: "thread-1",
  sessionKey: "thread-1",
  title: "Native thread",
  status: "idle",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  metadata: { extra: {} },
};

function canonicalRuntimeState(runId: string, status = "running") {
  return {
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId: "thread-1",
      runId,
      snapshotRevision: 2,
      items: [
        {
          schemaVersion: "tinybot.turn_item.v2",
          itemId: `${runId}:user`,
          sessionId: "thread-1",
          threadId: "thread-1",
          runId,
          turnId: runId,
          sequence: 1,
          revision: 1,
          kind: "user_message",
          status: "completed",
          createdAt: "2026-07-14T00:00:01.000Z",
          data: { type: "user_message", messageId: `${runId}:user`, content: "hello" },
        },
        {
          schemaVersion: "tinybot.turn_item.v2",
          itemId: `${runId}:assistant`,
          sessionId: "thread-1",
          threadId: "thread-1",
          runId,
          turnId: runId,
          sequence: 2,
          revision: 1,
          kind: "assistant_message",
          status,
          createdAt: "2026-07-14T00:00:02.000Z",
          data: { type: "assistant_message", messageId: `${runId}:assistant`, modelCallId: "call-1", phase: "final_answer", content: "hi" },
        },
      ],
    },
  };
}

describe("desktop native app services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_thread_create") return thread;
      if (command === "worker_agent_runs_list") return { runs: [] };
      if (command === "worker_agent_run_runtime_state") return null;
      if (command === "worker_session_effective_capabilities") return {
        schemaVersion: "tinybot.effective_capabilities.v1",
        sessionId: "thread-1",
        capabilities: {},
      };
      if (command === "worker_submit_thread_turn") return {
        threadId: "thread-1",
        sessionId: "thread-1",
        runId: "run-1",
        agentResult: {},
        snapshot: {},
      };
      return { command, args };
    });
  });

  test("lists and creates real Thread sessions", async () => {
    const services = createDesktopAppServices();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-1", title: "Native thread" }),
    ]);
    await expect(services.sessionStore.create({ title: "New Thread" })).resolves.toEqual(
      expect.objectContaining({ id: "thread-1" }),
    );

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_create", {
      input: { body: { title: "New Thread", source: "desktop" } },
    });
  });

  test("loads later Thread pages before filtering internal child sessions", async () => {
    const childThread = {
      ...thread,
      parentThreadId: "thread-1",
      source: "subagent",
      threadId: "thread-child",
      sessionKey: "thread-child",
    };
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") {
        const body = (args?.input as { body?: Record<string, unknown> } | undefined)?.body;
        return body?.offset === 1
          ? { threads: [thread], total: 2 }
          : { threads: [childThread], total: 2, nextOffset: 1 };
      }
      if (command === "worker_agent_runs_list") return { runs: [] };
      if (command === "worker_agent_run_runtime_state") return null;
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-1" }),
    ]);
    expect(mocks.invoke).toHaveBeenCalledWith("worker_threads_list", {
      input: { body: { includeChildThreads: true, offset: 1 } },
    });
  });

  test("persists session renames through Thread metadata", async () => {
    const services = createDesktopAppServices();

    await services.sessionStore.list();
    await services.sessionStore.rename("thread-1", "Durable title");

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_update_metadata", {
      input: {
        body: {
          threadId: "thread-1",
          metadata: { title: "Durable title" },
        },
      },
    });
  });

  test("submits chat messages through the typed Thread command", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-turn-1",
      message: { text: "hello", model: "model-1" },
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));

    expect(mocks.invoke).toHaveBeenCalledWith("worker_submit_thread_turn", {
      input: expect.objectContaining({
        threadId: "thread-1",
        input: expect.objectContaining({ role: "user", content: "hello", clientEventId: "command-turn-1" }),
        spec: expect.objectContaining({
          sessionId: "thread-1",
          stream: true,
          model: "model-1",
          metadata: expect.objectContaining({ clientEventId: "command-turn-1" }),
        }),
      }),
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "message-sent" }));
  });

  test("preserves live reasoning after the completed Thread result arrives", async () => {
    let completedRunId = "";
    let resolveSubmit!: (value: unknown) => void;
    const pendingSubmit = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") {
        return { runs: completedRunId ? [{ runId: completedRunId }] : [] };
      }
      if (command === "worker_agent_run_runtime_state") {
        return canonicalRuntimeState(completedRunId, "completed");
      }
      if (command === "worker_submit_thread_turn") {
        const input = args?.input as { spec?: { runId?: string } } | undefined;
        completedRunId = input?.spec?.runId ?? "";
        return pendingSubmit;
      }
      return {};
    });
    const services = createDesktopAppServices();
    await services.chatStore.load("thread-1");
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-live-reasoning",
      message: { text: "hello" },
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));
    const listener = mocks.listeners.get("agent:timeline:patch");
    expect(listener).toBeTypeOf("function");
    const baseItem = canonicalRuntimeState(completedRunId).timeline.items[0];
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: completedRunId,
        snapshotRevision: 1,
        item: {
          ...baseItem,
          itemId: `${completedRunId}:user`,
          runId: completedRunId,
          turnId: completedRunId,
        },
      },
    });
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: completedRunId,
        snapshotRevision: 2,
        item: {
          ...baseItem,
          itemId: `${completedRunId}:reasoning`,
          runId: completedRunId,
          turnId: completedRunId,
          sequence: 2,
          kind: "reasoning",
          status: "completed",
          data: {
            type: "reasoning",
            modelCallId: "call-1",
            summary: "The user is",
          },
        },
      },
    });
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: completedRunId,
        snapshotRevision: 3,
        item: {
          ...canonicalRuntimeState(completedRunId, "completed").timeline.items[1],
          sequence: 3,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const liveTimelineEvents = events.filter((event) => event.type === "timeline.patch");
    expect(liveTimelineEvents[liveTimelineEvents.length - 1]?.timeline?.turns[0].executionItems).toEqual([
      expect.objectContaining({
        id: `${completedRunId}:reasoning`,
        kind: "reasoning",
        summary: "The user is",
      }),
    ]);

    resolveSubmit({
      threadId: "thread-1",
      sessionId: "thread-1",
      runId: completedRunId,
      agentResult: { finalContent: "hi", stopReason: "final_response" },
      snapshot: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timelineEvents = events.filter((event) => event.type === "timeline.patch");
    expect(timelineEvents[timelineEvents.length - 1]?.timeline?.turns[0].executionItems).toEqual([
      expect.objectContaining({
        id: `${completedRunId}:reasoning`,
        kind: "reasoning",
        summary: "The user is",
      }),
    ]);
  });

  test("converges from the completed Thread result when the live timeline patch is missed", async () => {
    let completedRunId = "";
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") {
        return { runs: completedRunId ? [{ runId: completedRunId }] : [] };
      }
      if (command === "worker_agent_run_runtime_state") {
        return canonicalRuntimeState(completedRunId, "completed");
      }
      if (command === "worker_submit_thread_turn") {
        const input = args?.input as { spec?: { runId?: string } } | undefined;
        completedRunId = input?.spec?.runId ?? "";
        return {
          threadId: "thread-1",
          sessionId: "thread-1",
          runId: completedRunId,
          agentResult: {
            finalContent: "hi",
            stopReason: "final_response",
          },
          snapshot: {
            items: [{
              itemId: `${completedRunId}:assistant`,
              kind: {
                type: "assistant_message_completed",
                payload: { content: "hi", role: "assistant" },
              },
            }],
            turnItems: [],
          },
        };
      }
      return {};
    });
    const services = createDesktopAppServices();
    await services.chatStore.load("thread-1");
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-completed-result",
      message: { text: "hello" },
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.patch",
      timeline: expect.objectContaining({
        turns: [expect.objectContaining({
          id: completedRunId,
          status: "completed",
          finalAnswer: expect.objectContaining({ text: "hi" }),
        })],
      }),
    }));
    expect(events).toContainEqual({ type: "agent.event", eventType: "agent.turn.completed" });
  });

  test("consumes typed Tauri timeline patches without a Gateway frame", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") return { runs: [{ runId: "run-live" }] };
      if (command === "worker_agent_run_runtime_state") return canonicalRuntimeState("run-live");
      return {};
    });
    const services = createDesktopAppServices();
    await services.chatStore.load("thread-1");
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));
    const listener = mocks.listeners.get("agent:timeline:patch");
    expect(listener).toBeTypeOf("function");

    const assistantItem = canonicalRuntimeState("run-live").timeline.items[1];
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: "run-live",
        snapshotRevision: 3,
        item: {
          ...assistantItem,
          revision: 2,
          status: "running",
          updatedAt: "2026-07-14T00:00:03.000Z",
          data: { ...assistantItem.data, content: "hi there" },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: "run-live",
        snapshotRevision: 4,
        item: {
          ...assistantItem,
          revision: 3,
          status: "completed",
          updatedAt: "2026-07-14T00:00:04.000Z",
          data: { ...assistantItem.data, content: "hi there!" },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.patch",
      timeline: expect.objectContaining({
        turns: [expect.objectContaining({
          status: "running",
          finalAnswer: expect.objectContaining({ text: "hi there" }),
        })],
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "timeline.patch",
      timeline: expect.objectContaining({
        turns: [expect.objectContaining({
          status: "completed",
          finalAnswer: expect.objectContaining({ text: "hi there!" }),
        })],
      }),
    }));
    expect(events).toContainEqual({ type: "agent.event", eventType: "agent.turn.completed" });
  });

  test("uses typed Thread commands for interrupt and approval", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") return { runs: [{ runId: "run-live" }] };
      if (command === "worker_agent_run_runtime_state") return canonicalRuntimeState("run-live");
      return {};
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.dispatch(createDesktopStopCommand({
      commandId: "command-stop-1",
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));
    await services.chatStore.dispatch(createTinyOsApprovalResolveCommand({
      action: "approveSession",
      approvalId: "approval-1",
      commandId: "command-approval-1",
      runId: "run-live",
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
      threadId: "thread-1",
      turnId: "run-live",
    }));

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_interrupt", {
      input: { body: expect.objectContaining({
        threadId: "thread-1",
        runId: "run-live",
        clientEventId: "command-stop-1",
      }) },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("worker_resolve_thread_approval", {
      input: {
        threadId: "thread-1",
        approvalId: "approval-1",
        approved: true,
        commandId: "command-approval-1",
        scope: "session",
      },
    });
  });

  test("reloads the canonical timeline after resolving an approval", async () => {
    let approved = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") return { runs: [{ runId: "run-live" }] };
      if (command === "worker_agent_run_runtime_state") {
        return canonicalRuntimeState("run-live", approved ? "completed" : "running");
      }
      if (command === "worker_resolve_thread_approval") {
        approved = true;
        return { approvalResult: { approved: true, status: "approved" } };
      }
      return {};
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await expect(services.chatStore.load("thread-1")).resolves.toMatchObject({
      turns: [expect.objectContaining({ status: "running" })],
    });

    await services.chatStore.dispatch(createTinyOsApprovalResolveCommand({
      action: "approveOnce",
      approvalId: "approval-1",
      commandId: "command-approval-1",
      runId: "run-live",
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
      threadId: "thread-1",
      turnId: "run-live",
    }));

    await expect(services.chatStore.load("thread-1")).resolves.toMatchObject({
      turns: [expect.objectContaining({ status: "completed" })],
    });
  });

  test("forks a completed canonical turn into a registered Thread at the selected message boundary", async () => {
    const branchThread = {
      ...thread,
      parentThreadId: "thread-1",
      source: "fork",
      threadId: "thread-branch",
      sessionKey: "thread-branch",
      title: "Native thread · 分叉",
    };
    const subagentThread = {
      ...thread,
      parentThreadId: "thread-1",
      source: "subagent",
      threadId: "thread-subagent",
      sessionKey: "thread-subagent",
      title: "Internal subagent",
    };
    let forked = false;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") {
        const body = (args?.input as { body?: Record<string, unknown> } | undefined)?.body;
        const threads = forked && body?.includeChildThreads === true
          ? [branchThread, subagentThread, thread]
          : [thread];
        return { threads, total: threads.length };
      }
      if (command === "worker_agent_runs_list") return { runs: [{ runId: "run-completed" }] };
      if (command === "worker_agent_run_runtime_state") return canonicalRuntimeState("run-completed", "completed");
      if (command === "worker_thread_read") {
        return {
          items: [{
            itemId: "run-completed:assistant",
            sequence: 42,
            kind: {
              type: "assistant_message_completed",
              payload: { content: "hi", messageId: "run-completed:assistant" },
            },
          }],
          nextCursor: null,
        };
      }
      if (command === "worker_thread_fork") {
        forked = true;
        return branchThread;
      }
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.chatStore.branchFromMessage("thread-1", "run-completed:assistant")).resolves.toEqual(
      expect.objectContaining({ id: "thread-branch", title: "Native thread · 分叉" }),
    );
    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-branch" }),
      expect.objectContaining({ id: "thread-1" }),
    ]);

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_fork", {
      input: {
        body: {
          clientEventId: "fork:thread-1:run-completed:assistant",
          forkAfterSequence: 42,
          threadId: "thread-1",
          title: "Native thread · 分叉",
        },
      },
    });
  });

  test("deletes the Thread tree when a conversation has fork children", async () => {
    let deleted = false;
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") {
        return { threads: deleted ? [] : [thread], total: deleted ? 0 : 1 };
      }
      if (command === "worker_thread_delete") {
        const body = (args?.input as { body?: Record<string, unknown> } | undefined)?.body;
        if (body?.deleteChildren !== true) {
          throw new Error("thread-delete failed: thread has child threads; pass deleteChildren to delete the tree");
        }
        deleted = true;
        return { deleted: true, deletedChildren: ["thread-branch"] };
      }
      if (command === "worker_agent_runs_list") return { runs: [] };
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.sessionStore.delete("thread-1")).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_delete", {
      input: {
        body: {
          deleteChildren: true,
          threadId: "thread-1",
        },
      },
    });
  });
});
