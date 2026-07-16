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

    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        runId: "run-live",
        snapshotRevision: 3,
        item: {
          ...canonicalRuntimeState("run-live", "completed").timeline.items[1],
          revision: 2,
          status: "completed",
          updatedAt: "2026-07-14T00:00:03.000Z",
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContainEqual(expect.objectContaining({ type: "timeline.patch" }));
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
        scope: "session",
      },
    });
  });

  test("branches a completed canonical turn with portable message history", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_agent_runs_list") return { runs: [{ runId: "run-completed" }] };
      if (command === "worker_agent_run_runtime_state") return canonicalRuntimeState("run-completed", "completed");
      if (command === "worker_session_branch") return { key: "thread-branch", title: "Native thread · Branch" };
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.chatStore.branchFromMessage("thread-1", "run-completed:assistant")).resolves.toEqual(
      expect.objectContaining({ id: "thread-branch", title: "Native thread · Branch" }),
    );

    expect(mocks.invoke).toHaveBeenCalledWith("worker_session_branch", {
      input: {
        body: {
          branchedFromMessageId: "run-completed:assistant",
          branchedFromSessionId: "thread-1",
          messages: [
            { content: "hello", messageId: "run-completed:user", role: "user" },
            { content: "hi", messageId: "run-completed:assistant", role: "assistant" },
          ],
          portableContext: { chatId: "thread-1", sessionKey: "thread-1" },
          runtimeState: {},
          title: "Native thread · 分叉",
        },
      },
    });
  });
});
