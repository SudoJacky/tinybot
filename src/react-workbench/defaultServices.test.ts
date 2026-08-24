// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDesktopAppServices } from "./defaultServices";
import type { ChatEvent } from "./services";
import { createDesktopCompactCommand, createDesktopStopCommand, createDesktopTurnSubmitCommand } from "../app-core/chat/desktopCommand";

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
const thread = {
  threadId: "thread-1",
  sessionKey: "thread-1",
  title: "Native thread",
  status: "idle",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  metadata: {
    workingDirectory: "D:\\Code\\py\\tinybot",
    extra: {},
  },
};

function canonicalRuntimeState(turnId: string, status = "running") {
  return {
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId: "thread-1",
      turnId,
      snapshotRevision: 2,
      items: [
        {
          schemaVersion: "tinybot.turn_item.v2",
          itemId: `${turnId}:user`,
          sessionId: "thread-1",
          threadId: "thread-1",
          turnId,
          sequence: 1,
          revision: 1,
          kind: "user_message",
          status: "completed",
          createdAt: "2026-07-14T00:00:01.000Z",
          data: { type: "user_message", messageId: `${turnId}:user`, content: "hello" },
        },
        {
          schemaVersion: "tinybot.turn_item.v2",
          itemId: `${turnId}:assistant`,
          sessionId: "thread-1",
          threadId: "thread-1",
          turnId,
          sequence: 2,
          revision: 1,
          kind: "assistant_message",
          status,
          createdAt: "2026-07-14T00:00:02.000Z",
          data: { type: "assistant_message", messageId: `${turnId}:assistant`, modelCallId: "call-1", phase: "final_answer", content: "hi" },
        },
      ],
    },
  };
}

describe("desktop native app services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    window.localStorage.clear();
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "worker_thread_create") return thread;
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      if (command === "thread_get_effective_capabilities") return {
        schemaVersion: "tinybot.effective_capabilities.v2",
        threadId: "thread-1",
        capabilities: {},
      };
      if (command === "worker_submit_thread_turn") return {
        threadId: "thread-1",
        sessionId: "thread-1",
        turnId: "turn-1",
      };
      return { command, args };
    });
  });

  test("initializes directly through native Thread commands", async () => {
    const services = createDesktopAppServices();

    await services.sessionStore.list();

    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).toContain("worker_threads_list");
  });

  test("reports native event and session startup phases", async () => {
    const startupTrace = {
      complete: vi.fn(),
      fail: vi.fn(),
      mark: vi.fn(),
      start: vi.fn(),
    };
    const services = createDesktopAppServices({ startupTrace });

    await services.sessionStore.list();

    expect(startupTrace.start).toHaveBeenCalledWith("events.register");
    expect(startupTrace.complete).toHaveBeenCalledWith("events.register");
    expect(startupTrace.start).toHaveBeenCalledWith("sessions.load");
    expect(startupTrace.complete).toHaveBeenCalledWith("sessions.load", {
      pageCount: 1,
      sessionCount: 1,
    });
    expect(startupTrace.mark).toHaveBeenCalledWith("services.ready");
  });

  test("loads performance diagnostics without waiting for chat initialization", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_performance_snapshot") {
        return {
          schemaVersion: "tinybot.performance_trace.v1",
          generatedAtUnixMs: 1,
          metrics: {
            schemaVersion: 1,
            generatedAtUnixMs: 1,
            counters: {},
            durations: {},
            gauges: {},
          },
          recentEvents: [],
        };
      }
      if (command === "worker_threads_list") {
        throw new Error("chat initialization should not run");
      }
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.performanceStore!.load()).resolves.toMatchObject({
      schemaVersion: "tinybot.performance_trace.v1",
    });

    expect(mocks.invoke).toHaveBeenCalledWith("desktop_performance_snapshot");
    expect(mocks.invoke).not.toHaveBeenCalledWith("worker_threads_list", expect.anything());
  });

  test("exports a performance snapshot without waiting for chat initialization", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "save_export_file") {
        return { path: "C:\\Temp\\tinybot-performance-trace.json" };
      }
      if (command === "worker_threads_list") {
        throw new Error("chat initialization should not run");
      }
      return {};
    });
    const services = createDesktopAppServices();
    const snapshot = {
      schemaVersion: "tinybot.performance_trace.v1" as const,
      generatedAtUnixMs: 1,
      metrics: {
        schemaVersion: 1,
        generatedAtUnixMs: 1,
        counters: {},
        durations: {},
        gauges: {},
      },
      recentEvents: [],
    };

    await expect(services.performanceStore!.exportSnapshot(snapshot)).resolves.toEqual({
      path: "C:\\Temp\\tinybot-performance-trace.json",
    });

    expect(mocks.invoke).toHaveBeenCalledWith("save_export_file", expect.objectContaining({
      options: expect.objectContaining({ contents: `${JSON.stringify(snapshot, null, 2)}\n` }),
    }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("worker_threads_list", expect.anything());
  });

  test("loads the canonical active memory snapshot", async () => {
    const snapshot = {
      currentWorkspacePath: "D:\\Code\\py\\tinybot",
      userMemories: ["User prefers concise answers."],
      workspaces: [{
        current: true,
        path: "D:\\Code\\py\\tinybot",
        memories: ["This workspace uses Rust."],
      }],
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      if (command === "worker_memory_snapshot") return snapshot;
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.memoryStore.load()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith("worker_memory_snapshot");
  });

  test("loads models from every enabled provider instead of only the default provider", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      if (command === "get_config_editor_snapshot") {
        return {
          effectivePublicConfig: {
            agents: { defaults: { activeProfile: "deepseek-default", model: "deepseek-chat" } },
            providers: {
              profiles: {
                "deepseek-default": {
                  provider: "deepseek",
                  displayName: "DeepSeek",
                  enabled: true,
                  models: ["deepseek-chat"],
                },
                "openai-default": {
                  provider: "openai",
                  displayName: "OpenAI",
                  enabled: true,
                  models: ["gpt-5"],
                },
              },
            },
          },
        };
      }
      if (command === "worker_webui_route") {
        return {
          status: 200,
          body: {
            providers: [
              { id: "deepseek", displayName: "DeepSeek", status: "ready" },
              { id: "openai", displayName: "OpenAI", status: "ready" },
            ],
          },
        };
      }
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.settingsStore.loadChatModels?.()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek-chat", providerId: "deepseek" }),
      expect.objectContaining({ id: "gpt-5", providerId: "openai" }),
    ]));
  });

  test("loads and saves personalization instructions through USER.md with revision checks", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      if (command === "worker_workspace_bootstrap_files") {
        return {
          files: [{ path: "USER.md", contents: "Keep answers concise.", updated_at: "unix-ms:100" }],
          missing: [],
        };
      }
      if (command === "worker_workspace_put_file") {
        return { path: "USER.md", bytes_written: 33, updated_at: "unix-ms:200" };
      }
      return {};
    });
    const services = createDesktopAppServices();

    await expect(services.settingsStore.loadPersonalizationInstructions?.()).resolves.toEqual({
      path: "USER.md",
      contents: "Keep answers concise.",
      updatedAt: "unix-ms:100",
    });
    await expect(services.settingsStore.savePersonalizationInstructions?.({
      contents: "Keep answers concise and concrete.",
      expectedUpdatedAt: "unix-ms:100",
    })).resolves.toEqual({
      path: "USER.md",
      contents: "Keep answers concise and concrete.",
      updatedAt: "unix-ms:200",
    });

    expect(mocks.invoke).toHaveBeenCalledWith("worker_workspace_bootstrap_files", {
      input: { files: ["USER.md"] },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("worker_workspace_put_file", {
      input: {
        path: "USER.md",
        body: {
          content: "Keep answers concise and concrete.",
          expectedUpdatedAt: "unix-ms:100",
        },
      },
    });
  });

  test("reloads canonical runtime state whenever an existing session is loaded", async () => {
    const services = createDesktopAppServices();

    await services.chatStore.load("thread-1");
    const firstLoadCount = mocks.invoke.mock.calls
      .filter(([command]) => command === "thread_list_turns")
      .length;
    await services.chatStore.load("thread-1");

    const secondLoadCount = mocks.invoke.mock.calls
      .filter(([command]) => command === "thread_list_turns")
      .length;
    expect(secondLoadCount).toBe(firstLoadCount + 1);
  });

  test("lists and creates real Thread sessions", async () => {
    const services = createDesktopAppServices();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Native thread",
        workingDirectory: "D:\\Code\\py\\tinybot",
      }),
    ]);
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "model-current");
    await expect(services.sessionStore.create({
      title: "New Thread",
      workingDirectory: "D:\\Code\\py\\tinybot",
      entryPoint: "desktop-pet",
    })).resolves.toEqual(
      expect.objectContaining({ id: "thread-1" }),
    );

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_create", {
      input: {
        body: {
          title: "New Thread",
          source: "desktop",
          metadata: {
            workingDirectory: "D:\\Code\\py\\tinybot",
            model: "model-current",
            extra: {
              entryPoint: "desktop-pet",
            },
          },
        },
      },
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
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
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

  test("keeps parentless Agent Graph threads out of Chat sessions", async () => {
    const graphThread = {
      ...thread,
      source: "agent_graph",
      threadId: "thread-graph-node",
      sessionKey: "thread-graph-node",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") {
        return { threads: [graphThread, thread], total: 2 };
      }
      return null;
    });
    const services = createDesktopAppServices();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-1" }),
    ]);
  });

  test("keeps user-visible workspace child threads in the session list", async () => {
    const workspaceThread = {
      ...thread,
      parentThreadId: "thread-1",
      source: "workspace_thread",
      threadId: "thread-workspace-child",
      sessionKey: "thread-workspace-child",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") {
        return { threads: [workspaceThread, thread], total: 2 };
      }
      return null;
    });
    const services = createDesktopAppServices();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-workspace-child" }),
      expect.objectContaining({ id: "thread-1" }),
    ]);
  });

  test("discovers a workspace child thread from its first live timeline patch", async () => {
    const workspaceThread = {
      ...thread,
      parentThreadId: "thread-1",
      source: "workspace_thread",
      threadId: "thread-workspace-live",
      sessionKey: "thread-workspace-live",
    };
    let childCreated = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") {
        return {
          threads: childCreated ? [workspaceThread, thread] : [thread],
          total: childCreated ? 2 : 1,
        };
      }
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      return {};
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));
    childCreated = true;

    mocks.listeners.get("agent:timeline:patch")?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-workspace-live",
        turnId: "turn-workspace-live",
        snapshotRevision: 1,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-workspace-live" }),
      expect.objectContaining({ id: "thread-1" }),
    ]);
    expect(events).toContainEqual({ type: "chat.created" });
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
      message: {
        text: "hello",
        model: "model-1",
        provider: "openai",
        reasoningEffort: "xhigh",
        selectedSkills: ["create-agent-plugin:migrate-agent-plugin"],
      },
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
          provider: "openai",
          reasoningEffort: "xhigh",
          metadata: expect.objectContaining({
            clientEventId: "command-turn-1",
            selectedSkills: ["create-agent-plugin:migrate-agent-plugin"],
          }),
        }),
      }),
    });
    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_update_metadata", {
      input: {
        body: {
          threadId: "thread-1",
          metadata: { model: "model-1", extra: { modelProvider: "openai" } },
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "message-sent" }));
  });

  test("uses the Thread model when an automatic turn omits model", async () => {
    const modeledThread = {
      ...thread,
      metadata: {
        ...thread.metadata,
        model: "thread-model",
      },
    };
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [modeledThread], total: 1 };
      if (command === "thread_list_turns") return { turns: [] };
      if (command === "thread_get_turn_runtime_state") return null;
      if (command === "worker_submit_thread_turn") {
        const input = args?.input as { spec?: { turnId?: string } } | undefined;
        return {
          threadId: "thread-1",
          sessionId: "thread-1",
          turnId: input?.spec?.turnId,
        };
      }
      return {};
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-thread-model",
      message: { text: "continue" },
      sessionId: "thread-1",
      source: { control: "automatic", surface: "chat" },
    }));

    expect(mocks.invoke).toHaveBeenCalledWith("worker_submit_thread_turn", {
      input: expect.objectContaining({
        spec: expect.objectContaining({ model: "thread-model" }),
      }),
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("worker_thread_update_metadata", expect.anything());
  });

  test("projects native file references as optimistic attachment metadata", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-file-1",
      message: {
        references: [{
          detail: "MARKDOWN - 16 Bytes",
          kind: "reference",
          rawPath: "C:\\Users\\tester\\notes.md",
          title: "notes.md",
          type: "tinyos.file",
        }],
        text: "Review this file",
      },
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));

    expect(events).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        contextReferences: [expect.objectContaining({
          detail: "MARKDOWN - 16 Bytes",
          presentation: "attachment",
          title: "notes.md",
        })],
        text: "Review this file",
      }),
      type: "message-sent",
    }));
  });

  test("projects managed images as optimistic preview attachments", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));
    const imagePath = "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png";

    await services.chatStore.dispatch(createDesktopTurnSubmitCommand({
      commandId: "command-image-1",
      message: {
        references: [{
          contentHash: "abc123",
          detail: "PNG - 2 KB",
          kind: "reference",
          mimeType: "image/png",
          rawPath: imagePath,
          sizeBytes: 2048,
          title: "diagram.png",
          type: "tinyos.image",
        }],
        text: "Explain this image",
      },
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));

    expect(events).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        contextReferences: [expect.objectContaining({
          attachmentKind: "image",
          attachmentPreviewPath: imagePath,
          presentation: "attachment",
          title: "diagram.png",
        })],
        text: "Explain this image",
      }),
      type: "message-sent",
    }));
  });

  test("preserves live reasoning after the completed Thread result arrives", async () => {
    let completedTurnId = "";
    let resolveSubmit!: (value: unknown) => void;
    const pendingSubmit = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") {
        return { turns: completedTurnId ? [{ turnId: completedTurnId }] : [] };
      }
      if (command === "thread_get_turn_runtime_state") {
        return canonicalRuntimeState(completedTurnId, "completed");
      }
      if (command === "worker_submit_thread_turn") {
        const input = args?.input as { spec?: { turnId?: string } } | undefined;
        completedTurnId = input?.spec?.turnId ?? "";
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
    const baseItem = canonicalRuntimeState(completedTurnId).timeline.items[0];
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        turnId: completedTurnId,
        snapshotRevision: 1,
        item: {
          ...baseItem,
          itemId: `${completedTurnId}:user`,
          turnId: completedTurnId,
        },
      },
    });
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        turnId: completedTurnId,
        snapshotRevision: 2,
        item: {
          ...baseItem,
          itemId: `${completedTurnId}:reasoning`,
          turnId: completedTurnId,
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
        turnId: completedTurnId,
        snapshotRevision: 3,
        item: {
          ...canonicalRuntimeState(completedTurnId, "completed").timeline.items[1],
          sequence: 3,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const liveTimelineEvents = events.filter((event) => event.type === "timeline.patch");
    expect(liveTimelineEvents[liveTimelineEvents.length - 1]?.timeline?.turns[0].executionItems).toEqual([
      expect.objectContaining({
        id: `${completedTurnId}:reasoning`,
        kind: "reasoning",
        summary: "The user is",
      }),
    ]);

    resolveSubmit({
      threadId: "thread-1",
      sessionId: "thread-1",
      turnId: completedTurnId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timelineEvents = events.filter((event) => event.type === "timeline.patch");
    expect(timelineEvents[timelineEvents.length - 1]?.timeline?.turns[0].executionItems).toEqual([
      expect.objectContaining({
        id: `${completedTurnId}:reasoning`,
        kind: "reasoning",
        summary: "The user is",
      }),
    ]);
  });

  test("converges from the completed Thread result when the live timeline patch is missed", async () => {
    let completedTurnId = "";
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") {
        return { turns: completedTurnId ? [{ turnId: completedTurnId }] : [] };
      }
      if (command === "thread_get_turn_runtime_state") {
        return canonicalRuntimeState(completedTurnId, "completed");
      }
      if (command === "worker_submit_thread_turn") {
        const input = args?.input as { spec?: { turnId?: string } } | undefined;
        completedTurnId = input?.spec?.turnId ?? "";
        return {
          threadId: "thread-1",
          sessionId: "thread-1",
          turnId: completedTurnId,
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
          id: completedTurnId,
          status: "completed",
          finalAnswer: expect.objectContaining({ text: "hi" }),
        })],
      }),
    }));
    expect(events).toContainEqual({ type: "agent.event", eventType: "agent.turn.completed" });
  });

  test("consumes typed Tauri timeline patches without a transport frame", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") return { turns: [{ turnId: "turn-live" }] };
      if (command === "thread_get_turn_runtime_state") return canonicalRuntimeState("turn-live");
      return {};
    });
    const services = createDesktopAppServices();
    await services.chatStore.load("thread-1");
    const events: ChatEvent[] = [];
    services.chatStore.subscribe("thread-1", (event) => events.push(event));
    const listener = mocks.listeners.get("agent:timeline:patch");
    expect(listener).toBeTypeOf("function");

    const assistantItem = canonicalRuntimeState("turn-live").timeline.items[1];
    listener?.({
      payload: {
        schemaVersion: "tinybot.timeline_patch.v2",
        sessionId: "thread-1",
        turnId: "turn-live",
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
        turnId: "turn-live",
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

  test("uses the typed Thread command for interrupt", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "worker_threads_list") return { threads: [thread], total: 1 };
      if (command === "thread_list_turns") return { turns: [{ turnId: "turn-live" }] };
      if (command === "thread_get_turn_runtime_state") return canonicalRuntimeState("turn-live");
      return {};
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.dispatch(createDesktopStopCommand({
      commandId: "command-stop-1",
      sessionId: "thread-1",
      source: { control: "test", surface: "chat" },
    }));
    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_interrupt", {
      input: { body: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-live",
        clientEventId: "command-stop-1",
      }) },
    });
  });

  test("runs standalone context compaction through the typed Thread command", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.dispatch(createDesktopCompactCommand({
      commandId: "command-compact-1",
      sessionId: "thread-1",
      source: { control: "slash-compact", surface: "chat" },
    }));

    expect(mocks.invoke).toHaveBeenCalledWith("worker_compact_thread", {
      input: {
        threadId: "thread-1",
        clientEventId: "command-compact-1",
      },
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
      if (command === "thread_list_turns") return { turns: [{ turnId: "turn-completed" }] };
      if (command === "thread_get_turn_runtime_state") return canonicalRuntimeState("turn-completed", "completed");
      if (command === "worker_thread_read") {
        return {
          items: [{
            itemId: "turn-completed:assistant",
            sequence: 42,
            kind: {
              type: "assistant_message_completed",
              payload: { content: "hi", messageId: "turn-completed:assistant" },
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

    await expect(services.chatStore.branchFromMessage("thread-1", "turn-completed:assistant")).resolves.toEqual(
      expect.objectContaining({ id: "thread-branch", title: "Native thread · 分叉" }),
    );
    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-branch" }),
      expect.objectContaining({ id: "thread-1" }),
    ]);

    expect(mocks.invoke).toHaveBeenCalledWith("worker_thread_fork", {
      input: {
        body: {
          clientEventId: "fork:thread-1:turn-completed:assistant",
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
      if (command === "thread_list_turns") return { turns: [] };
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
