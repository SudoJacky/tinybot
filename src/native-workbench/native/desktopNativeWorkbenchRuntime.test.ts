import { describe, expect, test, vi } from "vitest";
import { createDesktopNativeWorkbenchRuntime } from "./desktopNativeWorkbenchRuntime";
import { normalizeNativeBackendEventPayload } from "./nativeBackendContract";

describe("desktop native workbench runtime", () => {
  test("loads gateway sessions and exposes a live chat model for the native shell", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [
            {
              key: "WebSocket:chat-live",
              chat_id: "chat-live",
              title: "Live gateway session",
              updated_at: "2026-06-03T08:10:00.000Z",
            },
          ],
        }),
        loadMessages: async () => ({
          messages: [
            {
              role: "user",
              content: "Show me native state.",
              timestamp: "2026-06-03T08:09:00.000Z",
              message_id: "user-1",
            },
          ],
        }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
    });

    await runtime.loadInitialChatState();

    expect(runtime.chat.activeChatId).toBe("chat-live");
    expect(runtime.chat.sessions).toHaveLength(1);
    expect(runtime.chat.messages.map((message) => message.content)).toEqual(["Show me native state."]);
    expect(runtime.chat.status).toBe("Loaded 1 session from gateway.");
    expect(runtime.chat.responding).toBe(false);
    expect(sentSocketMessages).toContainEqual({ type: "attach", chat_id: "chat-live" });
  });

  test("patches session metadata through the native chat runtime", async () => {
    const patched: unknown[] = [];
    let sessions = [{
      key: "WebSocket:chat-live",
      chat_id: "chat-live",
      title: "Live gateway session",
      metadata: { pinned: false },
    }];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({ items: sessions }),
        loadMessages: async () => ({ messages: [] }),
        patchSession: async (sessionKey: string, body: unknown) => {
          patched.push({ body, sessionKey });
          sessions = [{
            key: "WebSocket:chat-live",
            chat_id: "chat-live",
            title: "Pinned gateway session",
            metadata: { pinned: true },
          }];
          return { key: sessionKey };
        },
      },
      sendSocketMessage: vi.fn(),
    });

    await runtime.loadInitialChatState();

    await expect(runtime.patchChatSession("WebSocket:chat-live", { metadata: { pinned: true } })).resolves.toBe(true);

    expect(patched).toEqual([{
      body: { metadata: { pinned: true } },
      sessionKey: "WebSocket:chat-live",
    }]);
    expect(runtime.chat.sessions[0]).toMatchObject({
      pinned: true,
      title: "Pinned gateway session",
    });
    expect(runtime.chat.status).toBe("Session updated.");
  });

  test("loads delegated artifacts through the native chat runtime", async () => {
    const getArtifact = vi.fn(async () => ({
      artifact: {
        artifactId: "artifact-1",
        content: "artifact body",
      },
    }));
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        getArtifact,
        listSessions: async () => ({ items: [] }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: vi.fn(),
    });

    await expect(runtime.loadArtifact({
      artifactId: "artifact-1",
      delegateId: "delegate-1",
      sessionKey: "WebSocket:chat-1",
      traceRef: "trace-1",
    })).resolves.toEqual({
      artifact: {
        artifactId: "artifact-1",
        content: "artifact body",
      },
    });
    expect(getArtifact).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      delegateId: "delegate-1",
      sessionKey: "WebSocket:chat-1",
      traceRef: "trace-1",
    });
  });

  test("selects a native chat session, reloads messages, and reattaches the gateway socket", async () => {
    const loadedKeys: string[] = [];
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [
            { key: "WebSocket:chat-1", chat_id: "chat-1", title: "First chat" },
            { key: "WebSocket:chat-2", chat_id: "chat-2", title: "Second chat" },
          ],
        }),
        loadMessages: async (sessionKey: string) => {
          loadedKeys.push(sessionKey);
          return { messages: [{ role: "assistant", content: `loaded ${sessionKey}`, message_id: `m-${sessionKey}` }] };
        },
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
    });
    await runtime.loadInitialChatState();

    await runtime.selectChatSession("WebSocket:chat-2", "chat-2");

    expect(runtime.chat.activeSessionKey).toBe("WebSocket:chat-2");
    expect(runtime.chat.activeChatId).toBe("chat-2");
    expect(runtime.chat.messages).toMatchObject([{ role: "assistant", content: "loaded WebSocket:chat-2" }]);
    expect(runtime.chat.status).toBe("Session loaded from gateway.");
    expect(loadedKeys).toEqual(["WebSocket:chat-1", "WebSocket:chat-2"]);
    expect(sentSocketMessages).toEqual([
      { type: "attach", chat_id: "chat-1" },
      { type: "attach", chat_id: "chat-2" },
    ]);
  });

  test("submits composer messages and keeps empty submissions local", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-live", chat_id: "chat-live", title: "Live gateway session" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
      now: () => "2026-06-03T08:11:00.000Z",
    });
    await runtime.loadInitialChatState();

    expect(runtime.submitComposerMessage("   ")).toEqual({ status: "empty" });
    expect(runtime.chat.status).toBe("Enter a message or attach a file before sending.");
    expect(runtime.chat.composerState).toBe("idle");

    expect(runtime.submitComposerMessage("Run native chat", false)).toEqual({
      status: "sent",
      chatId: "chat-live",
      content: "Run native chat",
    });
    expect(runtime.chat.composerState).toBe("sending");
    expect(sentSocketMessages).toContainEqual({
      type: "message",
      chat_id: "chat-live",
      content: "Run native chat",
      use_persistent_rag: false,
    });
    expect(runtime.chat.messages[runtime.chat.messages.length - 1]?.content).toBe("Run native chat");
    expect(runtime.chat.responding).toBe(true);
    expect(runtime.chat.usePersistentRag).toBe(false);

    await runtime.handleGatewayEvent({
      kind: "message.completed",
      chatId: "chat-live",
      messageId: "assistant-1",
      text: "Done",
      raw: {},
    });
    expect(runtime.chat.composerState).toBe("idle");
  });

  test("passes the configured native runtime model through gateway message frames", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-live", chat_id: "chat-live", title: "Live gateway session" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
    });
    await runtime.loadInitialChatState();
    runtime.setRuntimeMetadata({ provider: "deepseek", model: "deepseek-v4-flash" });

    runtime.submitComposerMessage("Use configured model", true);

    expect(sentSocketMessages).toContainEqual({
      type: "message",
      chat_id: "chat-live",
      content: "Use configured model",
      use_persistent_rag: true,
      model: "deepseek-v4-flash",
    });
  });

  test("keeps persistent RAG composer state independent from immediate sends", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-live", chat_id: "chat-live", title: "Live gateway session" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
    });
    await runtime.loadInitialChatState();

    runtime.setPersistentRag(false);
    expect(runtime.chat.usePersistentRag).toBe(false);

    runtime.submitComposerMessage("Use current RAG state");
    expect(sentSocketMessages).toContainEqual({
      type: "message",
      chat_id: "chat-live",
      content: "Use current RAG state",
      use_persistent_rag: false,
    });
  });

  test("can route active native chat submissions through the experimental TS agent runner", async () => {
    const sentSocketMessages: unknown[] = [];
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({
          messages: [{ role: "assistant", content: "Previous answer", message_id: "m-prev" }],
        }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "TS agent answer",
          stopReason: "final_response",
          messages: [],
          toolsUsed: [],
        };
      },
      now: () => "2026-06-03T08:15:00.000Z",
    });
    await runtime.loadInitialChatState();
    sentSocketMessages.length = 0;

    expect(runtime.submitComposerMessage("Use the TS loop", false)).toEqual({
      status: "sent",
      chatId: "chat-ts",
      content: "Use the TS loop",
    });
    await Promise.resolve();

    expect(sentSocketMessages).toEqual([]);
    expect(runSpecs).toMatchObject([
      {
        sessionId: "WebSocket:chat-ts",
        model: "deepseek-reasoner",
        stream: true,
        maxIterations: 8,
        metadata: {
          chatId: "chat-ts",
          route: "desktop-native-ts-agent",
          usePersistentRag: false,
        },
        messages: [
          { role: "assistant", content: "Previous answer" },
          { role: "user", content: "Use the TS loop" },
        ],
      },
    ]);
    expect(runtime.chat.messages).toMatchObject([
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Use the TS loop" },
      { role: "assistant", content: "TS agent answer" },
    ]);
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent response received.");
  });

  test("passes native context and iteration settings to the experimental TS agent runner", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "Configured TS agent answer",
          stopReason: "final_response",
          messages: [],
          toolsUsed: [],
        };
      },
      now: () => "2026-06-03T08:16:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.setRuntimeMetadata({
      model: "gpt-4.1",
      contextWindowTokens: 32768,
      maxToolIterations: 12,
      temperature: 0.2,
      maxTokens: 2048,
      reasoningEffort: "medium",
    });

    runtime.submitComposerMessage("Use configured budgets", false);
    await Promise.resolve();

    expect(runSpecs).toMatchObject([
      {
        model: "gpt-4.1",
        contextWindow: 32768,
        maxIterations: 12,
        temperature: 0.2,
        maxTokens: 2048,
        reasoningEffort: "medium",
      },
    ]);
  });

  test("preserves native tool-call history when routing a session to the experimental TS agent runner", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({
          messages: [
            { role: "user", content: "Read README", message_id: "m-user" },
            {
              role: "assistant",
              content: "",
              message_id: "m-tool-call",
              tool_calls: [
                {
                  id: "call-read",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              content: "README contents",
              message_id: "m-tool-result",
              tool_call_id: "call-read",
              name: "read_file",
            },
          ],
        }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "Continued answer",
          stopReason: "final_response",
          messages: [],
          toolsUsed: [],
        };
      },
      now: () => "2026-06-03T08:17:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Continue from history", false);
    await Promise.resolve();

    expect(runSpecs).toMatchObject([
      {
        messages: [
          { role: "user", content: "Read README" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-read",
                name: "read_file",
                argumentsJson: "{\"path\":\"README.md\"}",
              },
            ],
          },
          {
            role: "tool",
            content: "README contents",
            toolCallId: "call-read",
            name: "read_file",
          },
          { role: "user", content: "Continue from history" },
        ],
      },
    ]);
  });

  test("interrupts active TS agent runs through the experimental cancel command", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const sentSocketMessages: unknown[] = [];
    const cancelledRunIds: string[] = [];
    const runSpecs: Array<{ runId: string }> = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push({ runId: spec.runId });
        return runPromise;
      },
      cancelTsAgent: async (runId) => {
        cancelledRunIds.push(runId);
      },
      now: () => "2026-06-03T08:15:00.000Z",
    });
    await runtime.loadInitialChatState();
    sentSocketMessages.length = 0;

    runtime.submitComposerMessage("Cancel this TS run");
    expect(runtime.interruptActiveChat()).toBe(true);
    await Promise.resolve();

    expect(cancelledRunIds).toEqual([runSpecs[0].runId]);
    expect(sentSocketMessages).toEqual([]);
    expect(runtime.chat.status).toBe("TS agent interrupt requested.");

    runtime.handleTsAgentWorkerEvent("agent.done", { runId: runSpecs[0].runId, stopReason: "cancelled" });
    resolveRun?.({ finalContent: "", stopReason: "cancelled", messages: [], toolsUsed: [] });
    await runPromise;
  });

  test("restores TS agent checkpoint metadata after loading an experimental route session", async () => {
    const restoredSessionIds: string[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async () => ({
        finalContent: "",
        stopReason: "final_response",
        messages: [],
        toolsUsed: [],
      }),
      restoreTsAgentCheckpoint: async (sessionId) => {
        restoredSessionIds.push(sessionId);
        return {
          sessionId,
          checkpoint: {
            runId: "run-restored",
            phase: "awaiting_tools",
            iteration: 2,
            model: "test-model",
            pendingToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
            completedToolResults: [],
          },
        };
      },
    });

    await runtime.loadInitialChatState();

    expect(restoredSessionIds).toEqual(["WebSocket:chat-ts"]);
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toBe("Awaiting tools · iteration 3 · 1 pending tool");
    expect(runtime.chat.status).toBe("TS agent checkpoint restored.");
  });

  test("refreshes TS agent checkpoint metadata when selecting another experimental route session", async () => {
    const restoredSessionIds: string[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [
            { key: "WebSocket:chat-ts-1", chat_id: "chat-ts-1", title: "TS route 1" },
            { key: "WebSocket:chat-ts-2", chat_id: "chat-ts-2", title: "TS route 2" },
          ],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async () => ({
        finalContent: "",
        stopReason: "final_response",
        messages: [],
        toolsUsed: [],
      }),
      restoreTsAgentCheckpoint: async (sessionId) => {
        restoredSessionIds.push(sessionId);
        return {
          sessionId,
          checkpoint: sessionId.endsWith("chat-ts-1")
            ? {
              runId: "run-restored",
              phase: "awaiting_tools",
              iteration: 0,
              model: "test-model",
              pendingToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
              completedToolResults: [],
            }
            : null,
        };
      },
    });

    await runtime.loadInitialChatState();
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toBe("Awaiting tools · iteration 1 · 1 pending tool");

    await runtime.selectChatSession("WebSocket:chat-ts-2", "chat-ts-2");

    expect(restoredSessionIds).toEqual(["WebSocket:chat-ts-1", "WebSocket:chat-ts-2"]);
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toBeUndefined();
    expect(runtime.chat.status).toBe("Session loaded from gateway.");
  });

  test("projects TS agent worker stream events into the active native chat", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:16:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream with TS");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.reasoning_delta", { runId, delta: "plan " });
    runtime.handleTsAgentWorkerEvent("agent.delta", { runId, delta: "answer" });
    runtime.handleTsAgentWorkerEvent("agent.done", { runId, stopReason: "final_response" });
    resolveRun?.({ finalContent: "answer", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream with TS" },
      { role: "assistant", reasoningContent: "plan ", content: "answer", messageId: runId },
    ]);
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent response received.");
  });

  test("completes TS agent runs from returned cancelled events with run ids", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-cancelled", chat_id: "chat-ts-cancelled", title: "TS cancelled route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "",
          stopReason: "cancelled",
          messages: [],
          toolsUsed: [],
          error: "cancelled",
          events: [{
            eventName: "agent.cancelled",
            payload: {
              runId: spec.runId,
              sessionId: spec.sessionId,
              cancelled: true,
              stopReason: "cancelled",
            },
          }],
        };
      },
      now: () => "2026-06-03T08:16:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Cancel with returned event");
    await Promise.resolve();
    await Promise.resolve();

    expect(runSpecs).toHaveLength(1);
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent cancelled.");
  });

  test("projects Rust native backend event envelopes into the active native chat", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-rust", chat_id: "chat-rust", title: "Rust route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-29T14:30:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream through Rust envelope");
    const runId = String((runSpecs[0] as { runId: string }).runId);
    const envelope = {
      sessionId: "WebSocket:chat-rust",
      runId,
      traceId: "trace-rust-1",
      eventName: "agent.delta",
      timestamp: "2026-06-29T14:30:01.000Z",
      source: "rust_backend",
      payload: { runId, delta: "rust-owned contract" },
    } as const;

    runtime.handleTsAgentWorkerEvent(envelope.eventName, normalizeNativeBackendEventPayload(envelope));
    runtime.handleTsAgentWorkerEvent("agent.done", { runId, stopReason: "final_response" });
    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream through Rust envelope" },
      { role: "assistant", content: "rust-owned contract", messageId: runId },
    ]);
  });

  test("replays Rust native run result events through the frontend event projector", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-rust-result", chat_id: "chat-rust-result", title: "Rust result route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "rust final should not duplicate",
          stopReason: "final_response",
          messages: [],
          toolsUsed: ["workspace.read_file"],
          events: [
            {
              eventName: "agent.delta",
              payload: { runId: spec.runId, sessionId: spec.sessionId, delta: "rust answer" },
            },
            {
              eventName: "agent.tool_call.delta",
              payload: {
                runId: spec.runId,
                sessionId: spec.sessionId,
                toolCallId: "call-read",
                toolName: "workspace.read_file",
                argumentsDelta: "{\"path\":\"README.md\"}",
              },
            },
            {
              eventName: "agent.tool.result",
              payload: {
                runId: spec.runId,
                sessionId: spec.sessionId,
                toolCallId: "call-read",
                toolName: "workspace.read_file",
                content: "README",
              },
            },
            {
              eventName: "agent.done",
              payload: { runId: spec.runId, sessionId: spec.sessionId, stopReason: "final_response" },
            },
          ],
        };
      },
      now: () => "2026-06-29T14:31:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Run Rust result events");
    await Promise.resolve();
    await Promise.resolve();

    const runId = String((runSpecs[0] as { runId: string }).runId);
    expect(runtime.chat.messages[0]).toMatchObject({ role: "user", content: "Run Rust result events" });
    expect(runtime.chat.messages.find((message) => message.messageId === runId)).toMatchObject({
      role: "assistant",
      content: "rust answer",
      messageId: runId,
    });
    expect(runtime.chat.messages.some((message) => (
      message.toolActivities?.some((activity) => activity.responseText === "README")
    ))).toBe(true);
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent response received.");
  });

  test("accepts snake_case run metadata from TS agent worker events", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts", chat_id: "chat-ts", title: "TS route" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:15:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream snake case");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.delta", { run_id: runId, delta: "answer" });
    runtime.handleTsAgentWorkerEvent("agent.done", { run_id: runId, stop_reason: "final_response" });
    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream snake case" },
      { role: "assistant", content: "answer", messageId: runId },
    ]);
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
  });

  test("projects TS heartbeat delivery events into native chat without an active run", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-heartbeat", chat_id: "chat-heartbeat", title: "Heartbeat target" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      now: () => "2026-06-03T08:18:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.handleTsAgentWorkerEvent("heartbeat.delivery", {
      channel: "feishu",
      chat_id: "chat-heartbeat",
      content: "Heartbeat task completed.",
      tasks: "Notify the user when the heartbeat task is done.",
    });

    expect(runtime.chat.messages).toMatchObject([
      {
        role: "assistant",
        content: "Heartbeat task completed.",
        messageId: "heartbeat:chat-heartbeat:2026-06-03T08:18:00.000Z",
      },
    ]);
    expect(runtime.chat.status).toBe("Heartbeat notification delivered.");
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
  });

  test("projects TS agent worker tool events into native chat activities", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-tools", chat_id: "chat-tools", title: "TS tools" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:16:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Use a TS tool");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.tool.start", {
      runId,
      toolCallId: "call-memory",
      toolName: "search_memory_notes",
    });
    expect(runtime.chat.responding).toBe(true);
    runtime.handleTsAgentWorkerEvent("agent.tool.result", {
      runId,
      toolCallId: "call-memory",
      toolName: "search_memory_notes",
      content: "Found memory note",
    });
    expect(runtime.chat.responding).toBe(true);
    runtime.handleTsAgentWorkerEvent("agent.done", {
      runId,
      stopReason: "final_response",
    });
    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Use a TS tool" },
      {
        role: "assistant",
        content: "",
        toolActivities: [
          {
            id: "call-memory",
            name: "search_memory_notes",
            argsText: "search_memory_notes()",
            responseText: "Found memory note",
            kind: "result",
            status: "completed",
          },
        ],
      },
    ]);
    expect(runtime.chat.responding).toBe(false);
  });

  test("projects TS agent worker tool-call argument deltas into native chat activities", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-tool-delta", chat_id: "chat-tool-delta", title: "TS tool delta" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:16:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream tool args");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.tool_call.delta", {
      runId,
      index: 0,
      deltaText: "{\"query\"",
      toolCallId: "call-search",
      toolName: "search_memory_notes",
    });
    runtime.handleTsAgentWorkerEvent("agent.tool_call.delta", {
      runId,
      index: 0,
      deltaText: ":\"docs\"}",
    });
    runtime.handleTsAgentWorkerEvent("agent.tool.start", {
      runId,
      toolCallId: "call-search",
      toolName: "search_memory_notes",
    });
    runtime.handleTsAgentWorkerEvent("agent.tool.result", {
      runId,
      toolCallId: "call-search",
      toolName: "search_memory_notes",
      content: "Found docs note",
    });
    runtime.handleTsAgentWorkerEvent("agent.done", {
      runId,
      stopReason: "final_response",
    });
    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream tool args" },
      {
        role: "assistant",
        content: "",
        toolActivities: [
          {
            id: "call-search",
            name: "search_memory_notes",
            argsText: "search_memory_notes({\"query\":\"docs\"})",
            responseText: "Found docs note",
            kind: "result",
            status: "completed",
          },
        ],
      },
    ]);
    expect(runtime.chat.responding).toBe(false);
  });

  test("replays TS tool-call display text as JSON arguments in follow-up runs", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-follow-up", chat_id: "chat-ts-follow-up", title: "TS follow-up" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "",
          stopReason: "final_response",
          messages: [],
          toolsUsed: [],
        };
      },
      now: () => `2026-06-03T08:${15 + runSpecs.length}:00.000Z`,
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Find docs");
    await Promise.resolve();
    const firstRunId = String((runSpecs[0] as { runId: string }).runId);
    runtime.handleTsAgentWorkerEvent("agent.tool_call.delta", {
      runId: firstRunId,
      index: 0,
      deltaText: "{\"query\":\"docs\"}",
      toolCallId: "call-search",
      toolName: "search_memory_notes",
    });
    runtime.handleTsAgentWorkerEvent("agent.tool.result", {
      runId: firstRunId,
      toolCallId: "call-search",
      toolName: "search_memory_notes",
      content: "Found docs note",
    });
    runtime.handleTsAgentWorkerEvent("agent.done", {
      runId: firstRunId,
      stopReason: "final_response",
    });

    runtime.submitComposerMessage("Continue with that");
    await Promise.resolve();

    expect(runSpecs).toMatchObject([
      {},
      {
        messages: expect.arrayContaining([
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-search",
                name: "search_memory_notes",
                argumentsJson: "{\"query\":\"docs\"}",
              },
            ],
          },
          {
            role: "tool",
            content: "Found docs note",
            toolCallId: "call-search",
            name: "search_memory_notes",
          },
        ]),
      },
    ]);
  });

  test("exposes live runtime metadata for native composer chips", () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({ items: [] }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });

    runtime.setRuntimeMetadata({
      provider: "deepseek",
      model: "deepseek-chat",
      webSocket: "Connected",
      tokenReady: true,
      tokenUsage: "42%",
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(runtime.chat.runtime).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      webSocket: "Connected",
      tokenReady: true,
      tokenUsage: "42%",
      gatewayHttp: "http://127.0.0.1:18790",
    });
  });

  test("replays queued first messages with the selected RAG state after gateway chat creation", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-created", chat_id: "chat-created", title: "Created chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
      now: () => "2026-06-03T08:12:00.000Z",
    });

    expect(runtime.submitComposerMessage("First native prompt", false)).toEqual({
      status: "creating",
      pendingContent: "First native prompt",
    });
    expect(runtime.chat.status).toBe("Creating chat session before sending.");
    expect(runtime.chat.composerState).toBe("queued");
    expect(runtime.chat.usePersistentRag).toBe(false);

    await runtime.handleGatewayEvent({ kind: "chat.created", chatId: "chat-created", raw: {} });

    expect(runtime.chat.composerState).toBe("sending");
    expect(runtime.chat.activeChatId).toBe("chat-created");
    expect(runtime.chat.messages).toMatchObject([
      {
        role: "user",
        content: "First native prompt",
        timestamp: "2026-06-03T08:12:00.000Z",
      },
    ]);
    expect(runtime.chat.status).toBe("Queued message sent.");
    expect(sentSocketMessages).toEqual([
      { type: "new_chat" },
      {
        type: "message",
        chat_id: "chat-created",
        content: "First native prompt",
        use_persistent_rag: false,
      },
    ]);
  });

  test("projects stream deltas, interrupt, and gateway errors into native chat state", async () => {
    const sentSocketMessages: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-stream", chat_id: "chat-stream", title: "Streaming chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: (message) => {
        sentSocketMessages.push(message);
      },
      now: () => "2026-06-03T08:13:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream this");
    await runtime.handleGatewayEvent({
      kind: "message.delta",
      chatId: "chat-stream",
      messageId: "assistant-1",
      text: "thinking ",
      reasoning: true,
      raw: {},
    });
    await runtime.handleGatewayEvent({
      kind: "message.delta",
      chatId: "chat-stream",
      messageId: "assistant-1",
      text: "answer",
      reasoning: false,
      raw: {},
    });

    expect(runtime.chat.responding).toBe(true);
    expect(runtime.chat.composerState).toBe("sending");
    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream this" },
      { role: "assistant", reasoningContent: "thinking ", content: "answer", messageId: "assistant-1" },
    ]);

    expect(runtime.interruptActiveChat()).toBe(true);
    expect(sentSocketMessages).toContainEqual({ type: "interrupt", chat_id: "chat-stream" });
    await runtime.handleGatewayEvent({ kind: "interrupted", chatId: "chat-stream", cancelled: true, raw: {} });
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("Interrupt requested.");

    runtime.submitComposerMessage("Fail this");
    await runtime.handleGatewayEvent({ kind: "error", message: "gateway stream failed", raw: {} });
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("gateway stream failed");
  });

  test.each([
    "websocket-chat-gateway-stream-run",
    "openai-chat-chat-gateway-stream-run",
  ])("ignores direct TS agent stream events for %s gateway runs", async (runId) => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-gateway-stream", chat_id: "chat-gateway-stream", title: "Gateway stream" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    await runtime.handleGatewayEvent({
      kind: "message.delta",
      chatId: "chat-gateway-stream",
      messageId: runId,
      text: "hello",
      reasoning: false,
      raw: {},
    });
    runtime.handleTsAgentWorkerEvent("agent.delta", {
      runId,
      delta: "hello",
    });
    runtime.handleTsAgentWorkerEvent("agent.done", {
      runId,
      stopReason: "final_response",
    });

    expect(runtime.chat.messages).toMatchObject([
      { role: "assistant", content: "hello", messageId: runId },
    ]);
    expect(runtime.chat.messages).toHaveLength(1);
  });

  test("exposes stream deltas when the active gateway session uses a bare key", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "7e9e439b4487", chat_id: "chat-7e9e", title: "Bare key session" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      now: () => "2026-06-03T08:14:00.000Z",
    });
    await runtime.loadInitialChatState();

    runtime.submitComposerMessage("Stream with bare key");
    await runtime.handleGatewayEvent({
      kind: "message.delta",
      chatId: "chat-7e9e",
      messageId: "assistant-bare-key",
      text: "live answer",
      reasoning: false,
      raw: {},
    });

    expect(runtime.chat.activeSessionKey).toBe("7e9e439b4487");
    expect(runtime.chat.responding).toBe(true);
    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream with bare key" },
      { role: "assistant", content: "live answer", messageId: "assistant-bare-key" },
    ]);

    await runtime.handleGatewayEvent({
      kind: "message.stream.completed",
      chatId: "chat-7e9e",
      messageId: "assistant-bare-key",
      raw: {},
    });
    expect(runtime.chat.responding).toBe(false);
  });

  test("updates native runtime token usage from gateway usage events", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-usage", chat_id: "chat-usage", title: "Usage chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    await runtime.handleGatewayEvent({
      kind: "usage",
      chatId: "chat-usage",
      tokenUsage: "37%",
      raw: { event: "usage", usage: { total_tokens: 24248 } },
    });

    expect(runtime.chat.runtime?.tokenUsage).toBe("37%");
  });

  test("updates native runtime token usage from TS agent usage events", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-usage", chat_id: "chat-ts-usage", title: "TS usage chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    runtime.handleTsAgentWorkerEvent("agent.usage", {
      runId: "run-usage",
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        contextWindowTokens: 100,
      },
    });

    expect(runtime.chat.runtime?.tokenUsage).toBe("12%");
  });

  test("projects TS agent checkpoint events into native runtime metadata", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-checkpoint", chat_id: "chat-ts-checkpoint", title: "TS checkpoint chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    runtime.handleTsAgentWorkerEvent("agent.checkpoint", {
      runId: "run-checkpoint",
      phase: "awaiting_tools",
      iteration: 0,
      model: "test-model",
      pendingToolCalls: [{ id: "call-1", name: "search_memory_notes", argumentsJson: "{}" }],
      completedToolResults: [],
    });

    expect(runtime.chat.runtime?.tsAgentCheckpoint).toBe("Awaiting tools · iteration 1 · 1 pending tool");
    expect(runtime.chat.status).toBe("TS agent checkpoint: Awaiting tools.");
  });

  test("projects snake_case TS agent checkpoint tool counts into native runtime metadata", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-checkpoint-snake", chat_id: "chat-ts-checkpoint-snake", title: "TS checkpoint chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    runtime.handleTsAgentWorkerEvent("agent.checkpoint", {
      runId: "run-checkpoint-snake",
      phase: "awaiting_tools",
      iteration: 1,
      model: "test-model",
      pending_tool_calls: [{ id: "call-1", name: "read_file", arguments_json: "{}" }],
      completed_tool_results: [
        { tool_call_id: "call-0", name: "list_files", content: "[]" },
        { tool_call_id: "call-previous", name: "read_file", content: "ok" },
      ],
    });

    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("Awaiting tools");
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("iteration 2");
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("1 pending tool");
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("2 completed tools");
  });

  test.each([
    ["agent.done", { stopReason: "final_response" }],
    ["agent.cancelled", {}],
    ["agent.error", { message: "provider unavailable" }],
  ] as const)("clears TS agent checkpoint metadata after %s", async (eventName, terminalPayload) => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-terminal", chat_id: "chat-ts-terminal", title: "TS terminal chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });
    await runtime.loadInitialChatState();

    runtime.handleTsAgentWorkerEvent("agent.checkpoint", {
      runId: "run-terminal",
      phase: "awaiting_tools",
      iteration: 0,
      model: "test-model",
      pendingToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
      completedToolResults: [],
    });
    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("Awaiting tools");

    runtime.handleTsAgentWorkerEvent(eventName, {
      runId: "run-terminal",
      ...terminalPayload,
    });

    expect(runtime.chat.runtime?.tsAgentCheckpoint).toBeUndefined();
  });

  test("keeps TS agent checkpoint metadata while waiting for form input", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: string[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: string[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-form-wait", chat_id: "chat-ts-form-wait", title: "TS form wait" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:24:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Need user input");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.checkpoint", {
      runId,
      phase: "awaiting_form",
      iteration: 0,
      model: "test-model",
      pendingToolCalls: [{ id: "form-call-1", name: "request_form", argumentsJson: "{}" }],
      completedToolResults: [],
    });
    runtime.handleTsAgentWorkerEvent("agent.awaiting_form", {
      runId,
      stopReason: "awaiting_form",
      formId: "travel_plan",
      form: {
        form_id: "travel_plan",
        title: "Travel plan",
        correlation: { run_id: runId },
        fields: [
          { name: "destination", type: "text", label: "Destination", required: true },
        ],
      },
    });
    runtime.handleTsAgentWorkerEvent("agent.done", { runId, stopReason: "awaiting_form" });
    resolveRun?.({ finalContent: "", stopReason: "awaiting_form", messages: [], toolsUsed: ["request_form"] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.runtime?.tsAgentCheckpoint).toContain("Awaiting form");
    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent awaiting form input.");
  });

  test("projects TS agent awaiting form events into native Agent UI forms", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-form", chat_id: "chat-ts-form", title: "TS form chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async () => ({
        finalContent: "",
        stopReason: "awaiting_form",
        messages: [],
        toolsUsed: ["request_form"],
      }),
      now: () => "2026-06-03T08:20:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Need user input");

    runtime.handleTsAgentWorkerEvent("agent.awaiting_form", {
      runId: "desktop-ts-agent-20260603T082000000Z",
      stopReason: "awaiting_form",
      formId: "travel_plan",
      form: {
        form_id: "travel_plan",
        title: "Travel plan",
        description: "Choose the destination",
        correlation: { run_id: "desktop-ts-agent-20260603T082000000Z" },
        fields: [
          { name: "destination", type: "text", label: "Destination", required: true },
        ],
      },
    });

    expect(runtime.agentUiForms).toMatchObject([
      {
        form_id: "travel_plan",
        title: "Travel plan",
        description: "Choose the destination",
        status: "pending",
        chat_id: "chat-ts-form",
        correlation: {
          chat_id: "chat-ts-form",
          run_id: "desktop-ts-agent-20260603T082000000Z",
          session_id: "WebSocket:chat-ts-form",
        },
      },
    ]);
    expect(runtime.approvalOperations).toMatchObject([
      {
        id: "approval:form:travel_plan",
        title: "Travel plan",
        status: "waiting",
        canonical: { module: "approvals", entityId: "travel_plan", href: "/chat/chat-ts-form" },
      },
    ]);
    expect(runtime.chat.status).toBe("TS agent awaiting form input.");
  });

  test("projects TS agent awaiting approval events into native tool approvals", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-approval", chat_id: "chat-ts-approval", title: "TS approval chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "",
          stopReason: "awaiting_approval",
          messages: [],
          toolsUsed: ["request_approval"],
        };
      },
      now: () => "2026-06-03T08:21:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Need approval");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.tool.start", {
      runId,
      toolCallId: "call-spawn",
      toolName: "spawn",
    });

    runtime.handleTsAgentWorkerEvent("agent.awaiting_approval", {
      runId,
      stopReason: "awaiting_approval",
      approvalId: "approval-run-1",
      content: "Approve spawn",
      operation: {
        toolName: "spawn",
        arguments: { task: "say hello" },
      },
    });

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Need approval" },
      {
        role: "assistant",
        toolActivities: [
          {
            id: "call-spawn",
            name: "spawn",
            argsText: "spawn()",
            responseText: "Approve spawn",
            kind: "result",
            status: "blocked",
            approvalId: "approval-run-1",
            approvalStatus: "approval_required",
          },
        ],
      },
    ]);
    expect(runtime.chat.status).toBe("TS agent awaiting approval.");
  });

  test("keeps TS agent status waiting while an approval is pending", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: string[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: string[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-approval-wait", chat_id: "chat-ts-approval-wait", title: "TS approval wait" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:25:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Need approval");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.awaiting_approval", {
      runId,
      stopReason: "awaiting_approval",
      approvalId: "approval-run-1",
      content: "Approve write_file",
      operation: {
        toolName: "write_file",
        arguments: { path: "notes/today.md" },
      },
    });
    runtime.handleTsAgentWorkerEvent("agent.done", { runId, stopReason: "awaiting_approval" });
    resolveRun?.({ finalContent: "", stopReason: "awaiting_approval", messages: [], toolsUsed: ["request_approval"] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.responding).toBe(false);
    expect(runtime.chat.composerState).toBe("idle");
    expect(runtime.chat.status).toBe("TS agent awaiting approval.");
  });

  test("projects delegated TS agent tool results without duplicate spawn tool rows", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-delegate", chat_id: "chat-ts-delegate", title: "TS delegate chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "",
          stopReason: "completed",
          messages: [],
          toolsUsed: ["spawn"],
        };
      },
      now: () => "2026-06-03T08:27:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Spawn a subagent");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.tool.start", {
      runId,
      toolCallId: "call-spawn",
      toolName: "spawn",
    });
    runtime.handleTsAgentWorkerEvent("agent.tool.result", {
      runId,
      toolCallId: "call-spawn",
      toolName: "spawn",
      content: "child final result",
      metadata: {
        _delegate_event: true,
        _delegate_id: "delegate-1",
        _delegate_label: "打招呼",
        _delegate_result: { summary: "你好", status: "completed" },
        _delegate_status: "completed",
        _delegate_task: "请用中文说一句\"你好\"",
      },
    });

    const activities = runtime.chat.messages.flatMap((message) => message.toolActivities ?? []);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "call-spawn",
      kind: "result",
      name: "spawn",
      responseText: "child final result",
      status: "completed",
    });
    expect(activities[0]?.argsText).toContain("请用中文说一句");
    expect(runtime.chat.status).toBe("TS agent delegated work updated.");
  });

  test("projects TS agent task progress events into native chat activities", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-task", chat_id: "chat-ts-task", title: "TS task chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:23:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Track task progress");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.task_progress", {
      runId,
      toolCallId: "call-task",
      toolName: "update_plan",
      progress: {
        completed: 1,
        total: 3,
        pending: 2,
      },
    });

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Track task progress" },
      {
        role: "assistant",
        toolActivities: [
          {
            id: "call-task",
            name: "update_plan",
            responseText: "Task progress: 1/3",
            kind: "result",
            status: "running",
          },
        ],
      },
    ]);
    expect(runtime.chat.status).toBe("TS agent task progress updated.");

    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();
  });

  test("projects TS agent memory reference events into native chat references", async () => {
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-memory", chat_id: "chat-ts-memory", title: "TS memory chat" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return {
          finalContent: "Memory-backed answer",
          stopReason: "final_response",
          messages: [],
          toolsUsed: ["search_memory_notes"],
        };
      },
      now: () => "2026-06-03T08:22:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Use memory");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.delta", { runId, delta: "Memory-backed answer" });
    runtime.handleTsAgentWorkerEvent("agent.memory_reference", {
      runId,
      toolCallId: "call-memory",
      toolName: "search_memory_notes",
      references: [{
        note_id: "note_1",
        content: "Use workspace command policies.",
        file: "memory/notes.jsonl",
        line: 4,
        view_file: "memory/MEMORY.md",
        view_line: 18,
        scope: "project",
        type: "instruction",
      }],
    });

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Use memory" },
      {
        role: "assistant",
        content: "Memory-backed answer",
        references: [{
          kind: "memory",
          title: "note_1",
          detail: "Use workspace command policies.",
          sourcePath: "memory/MEMORY.md",
          sourceLine: 18,
          sourceText: "Use workspace command policies.",
          rawPath: "memory/notes.jsonl",
          rawLine: 4,
          noteId: "note_1",
          scope: "project",
          type: "instruction",
        }],
      },
    ]);
  });

  test("attaches TS agent done references to the streamed native chat message", async () => {
    let resolveRun: ((value: {
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }) => void) | undefined;
    const runPromise = new Promise<{
      finalContent: string;
      stopReason: string;
      messages: never[];
      toolsUsed: never[];
    }>((resolve) => {
      resolveRun = resolve;
    });
    const runSpecs: unknown[] = [];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({
          items: [{ key: "WebSocket:chat-ts-done-references", chat_id: "chat-ts-done-references", title: "TS done refs" }],
        }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
      agentRoute: "ts-agent",
      runTsAgent: async (spec) => {
        runSpecs.push(spec);
        return runPromise;
      },
      now: () => "2026-06-03T08:23:00.000Z",
    });
    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Stream done refs");
    const runId = String((runSpecs[0] as { runId: string }).runId);

    runtime.handleTsAgentWorkerEvent("agent.delta", { runId, delta: "Reference-backed answer" });
    runtime.handleTsAgentWorkerEvent("agent.done", {
      runId,
      stopReason: "final_response",
      _memory_references: [{
        note_id: "note_done",
        content: "Done payload memory",
        file: "memory/notes.jsonl",
        line: 8,
      }],
    });
    resolveRun?.({ finalContent: "", stopReason: "final_response", messages: [], toolsUsed: [] });
    await runPromise;
    await Promise.resolve();

    expect(runtime.chat.messages).toMatchObject([
      { role: "user", content: "Stream done refs" },
      {
        role: "assistant",
        content: "Reference-backed answer",
        messageId: runId,
        references: [{
          kind: "memory",
          title: "note_done",
          detail: "Done payload memory",
          sourcePath: "memory/notes.jsonl",
          sourceLine: 8,
          sourceText: "Done payload memory",
          noteId: "note_done",
        }],
      },
    ]);
  });

  test("reduces agent-ui form gateway events into native approval forms", async () => {
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({ items: [] }),
        loadMessages: async () => ({ messages: [] }),
      },
      sendSocketMessage: () => undefined,
    });

    await runtime.handleGatewayEvent({
      kind: "agent-ui.event",
      eventType: "ui.form.requested",
      raw: {
        event: "agent_ui_event",
        agent_ui_event: {
          event_type: "ui.form.requested",
          chat_id: "chat-1",
          payload: {
            form_id: "approval-form-1",
            title: "Approve deployment",
            description: "Confirm release target",
            correlation: { chat_id: "chat-1", message_id: "msg-1" },
            fields: [
              { name: "target", type: "text", label: "Target", required: true, default: "staging" },
              { name: "force", type: "checkbox", label: "Force", required: false, default: false },
            ],
          },
        },
      },
    });

    expect(runtime.agentUiForms).toMatchObject([
      {
        form_id: "approval-form-1",
        title: "Approve deployment",
        description: "Confirm release target",
        status: "pending",
        chat_id: "chat-1",
      },
    ]);
    expect(runtime.agentUiForms[0]?.fields.map((field) => field.name)).toEqual(["target", "force"]);
    expect(runtime.approvalOperations).toMatchObject([
      {
        id: "approval:form:approval-form-1",
        title: "Approve deployment",
        status: "waiting",
        canonical: { module: "approvals", entityId: "approval-form-1", href: "/chat/chat-1" },
      },
    ]);
    expect(runtime.chat.status).toBe("Agent UI form requested.");
  });
});
