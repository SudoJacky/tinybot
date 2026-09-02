import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeThreadsApi } from "./desktopNativeThreads";

describe("desktop native threads API", () => {
  test("maps thread service calls to Rust thread Tauri commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeThreadsApi({ invoke });

    await expect(api.list({ includeArchived: true })).resolves.toEqual({
      command: "worker_threads_list",
      args: { input: { body: { includeArchived: true } } },
    });
    await expect(api.read({ threadId: "thread-1" })).resolves.toEqual({
      command: "worker_thread_read",
      args: { input: { body: { threadId: "thread-1" } } },
    });
    await expect(api.resume({ threadId: "thread-1" })).resolves.toEqual({
      command: "worker_thread_resume",
      args: { input: { body: { threadId: "thread-1" } } },
    });
    await expect(api.activity({ threadId: "thread-1" })).resolves.toEqual({
      command: "worker_thread_activity",
      args: { input: { body: { threadId: "thread-1" } } },
    });
    await expect(api.startTurn({ threadId: "thread-1", input: { text: "hello" } })).resolves.toEqual({
      command: "worker_thread_start_turn",
      args: { input: { body: { threadId: "thread-1", input: { text: "hello" } } } },
    });
    await expect(api.applyOp({ threadId: "thread-1", op: { type: "interrupt" } })).resolves.toEqual({
      command: "worker_thread_apply_op",
      args: { input: { body: { threadId: "thread-1", op: { type: "interrupt" } } } },
    });
    await expect(api.listTurns("thread-1")).resolves.toEqual({
      command: "thread_list_turns",
      args: { input: { body: { threadId: "thread-1" } } },
    });
    await expect(api.getTurnRuntimeState("thread-1", "turn-1")).resolves.toEqual({
      command: "thread_get_turn_runtime_state",
      args: { input: { body: { threadId: "thread-1", turnId: "turn-1" } } },
    });
    await expect(api.getEffectiveCapabilities("thread-1")).resolves.toEqual({
      command: "thread_get_effective_capabilities",
      args: { input: { body: { threadId: "thread-1" } } },
    });
  });

  test("maps thread-first agent commands to direct command input", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeThreadsApi({ invoke });

    await expect(api.submitTurn({
      threadId: "thread-1",
      input: { role: "user", content: "hello", clientEventId: "client-1" },
      spec: { turnId: "turn-1", sessionId: "thread-1", stream: true, metadata: {} },
    })).resolves.toEqual({
      command: "worker_submit_thread_turn",
      args: {
        input: {
          threadId: "thread-1",
          input: { role: "user", content: "hello", clientEventId: "client-1" },
          spec: { turnId: "turn-1", sessionId: "thread-1", stream: true, metadata: {} },
        },
      },
    });
    await expect(api.compact({ threadId: "thread-1", clientEventId: "command-compact-1" })).resolves.toEqual({
      command: "worker_compact_thread",
      args: { input: { threadId: "thread-1", clientEventId: "command-compact-1" } },
    });
    await expect(api.submitForm({
      commandId: "command-form-1",
      threadId: "thread-1",
      formId: "form-1",
      source: { control: "chat-form", surface: "chat" },
      target: { sessionId: "thread-1", turnId: "turn-1" },
      values: {},
      action: "submit",
    })).resolves.toEqual({
      command: "worker_submit_thread_form",
      args: {
        input: {
          commandId: "command-form-1",
          threadId: "thread-1",
          formId: "form-1",
          source: { control: "chat-form", surface: "chat" },
          target: { sessionId: "thread-1", turnId: "turn-1" },
          values: {},
          action: "submit",
        },
      },
    });
    const retry = {
      commandId: "command-retry-1",
      source: { control: "error-recovery", surface: "chat" },
      sourceItemId: "turn-failed:error",
      sourceTurnId: "turn-failed",
      targetTurnId: "turn-retry",
      threadId: "thread-1",
    };
    await expect(api.retryOperation(retry)).resolves.toEqual({
      command: "worker_retry_thread_operation",
      args: { input: retry },
    });
  });
});
