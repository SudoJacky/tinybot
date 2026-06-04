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
