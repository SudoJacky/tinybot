import { describe, expect, test } from "vitest";
import { createDesktopNativeWorkbenchRuntime } from "./desktopNativeWorkbenchRuntime";

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
        model: "default",
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
    runtime.handleTsAgentWorkerEvent("agent.tool.result", {
      runId,
      toolCallId: "call-memory",
      toolName: "search_memory_notes",
      content: "Found memory note",
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
