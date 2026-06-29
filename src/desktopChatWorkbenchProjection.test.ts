import { describe, expect, test } from "vitest";
import {
  buildDesktopChatWorkbenchProjection,
  type DesktopChatWorkbenchContextAttachment,
} from "./desktopChatWorkbenchProjection";
import type { NativeChatMessage, NativeChatSession } from "./nativeChat";

const sessions: NativeChatSession[] = [
  {
    key: "WebSocket:chat-1",
    chatId: "chat-1",
    title: "Pinned architecture review",
    createdAt: "2026-06-01T08:00:00Z",
    updatedAt: "2026-06-03T09:00:00Z",
  },
  {
    key: "WebSocket:chat-2",
    chatId: "chat-2",
    title: "Workspace edits",
    createdAt: "2026-06-02T08:00:00Z",
    updatedAt: "2026-06-02T11:00:00Z",
  },
  {
    key: "WebSocket:chat-3",
    chatId: "chat-3",
    title: "Knowledge upload",
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T11:30:00Z",
  },
];

const messages: NativeChatMessage[] = [
  {
    role: "user",
    content: "Review desktop plan",
    reasoningContent: "",
    timestamp: "2026-06-03T09:00:00Z",
    messageId: "m-user",
  },
  {
    role: "assistant",
    content: "I need a file.",
    reasoningContent: "Check context",
    timestamp: "2026-06-03T09:00:01Z",
    messageId: "m-assistant",
    toolActivities: [
      {
        id: "call-read",
        name: "read_file",
        argsText: "{\"path\":\"NATIVE_APP_OVERVIEW.md\"}",
        responseText: "",
        kind: "call",
        approvalStatus: "pending",
      },
      {
        id: "call-shell",
        name: "shell",
        argsText: "",
        responseText: "ok",
        kind: "result",
      },
    ],
    references: [
      {
        kind: "reference",
        title: "Native overview",
        detail: "NATIVE_APP_OVERVIEW.md",
      },
    ],
  },
];

const attachments: DesktopChatWorkbenchContextAttachment[] = [
  {
    id: "file-readme",
    label: "README.md",
    scope: "session",
    detail: "Attached to this chat",
  },
  {
    id: "knowledge-native",
    label: "Native app docs",
    scope: "knowledge",
    detail: "Persistent RAG",
  },
];

describe("desktop chat workbench projection", () => {
  test("groups sidebar sessions with search, pinned state, metadata badges, and actions", () => {
    const projection = buildDesktopChatWorkbenchProjection({
      sessions,
      activeSessionKey: "WebSocket:chat-2",
      activeChatId: "chat-2",
      messages,
      responding: false,
      pinnedSessionKeys: new Set(["WebSocket:chat-1"]),
      searchQuery: "work",
    });

    expect(projection.sidebar.search.query).toBe("work");
    expect(projection.sidebar.groups).toEqual([
      {
        id: "recent",
        label: "Recent",
        sessions: [
          expect.objectContaining({
            sessionKey: "WebSocket:chat-2",
            active: true,
            badge: "2 messages",
            actions: ["open", "rename", "pin", "delete"],
          }),
        ],
      },
    ]);
  });

  test("builds chat header status from runtime, Knowledge, file scope, tokens, and metadata actions", () => {
    const projection = buildDesktopChatWorkbenchProjection({
      sessions,
      activeSessionKey: "WebSocket:chat-1",
      activeChatId: "chat-1",
      messages,
      responding: true,
      usePersistentRag: true,
      runtime: {
        provider: "openai",
        model: "gpt-5",
        tokenUsage: "1.2k / 8k",
        tokenReady: true,
      },
      attachments,
    });

    expect(projection.header).toEqual({
      title: "Pinned architecture review",
      subtitle: "openai / gpt-5",
      model: "gpt-5",
      provider: "openai",
      knowledgeEnabled: true,
      fileScopeLabel: "2 context items",
      tokenMeter: { label: "1.2k / 8k", ready: true },
      responding: true,
      actions: ["stop", "metadata", "new-chat"],
    });
  });

  test("creates virtualized timeline items with tool cards, inline approvals, forms, and references", () => {
    const projection = buildDesktopChatWorkbenchProjection({
      sessions,
      activeSessionKey: "WebSocket:chat-1",
      activeChatId: "chat-1",
      messages,
      responding: true,
      virtualWindow: { start: 1, size: 1 },
      pendingFormIds: ["provider-form"],
    });

    expect(projection.timeline.total).toBe(2);
    expect(projection.timeline.window).toEqual({ start: 1, end: 2, size: 1 });
    expect(projection.timeline.items).toEqual([
      expect.objectContaining({
        id: "m-assistant",
        role: "assistant",
        reasoningVisible: true,
        referenceCount: 1,
        toolCards: [
          expect.objectContaining({
            id: "call-read",
            state: "approval-pending",
            inlineApproval: true,
          }),
          expect.objectContaining({
            id: "call-shell",
            state: "completed",
            inlineApproval: false,
          }),
        ],
        formCards: [{ id: "provider-form", state: "pending" }],
      }),
    ]);
  });

  test("exposes composer context chips, RAG toggle, and send or interrupt controls", () => {
    const idle = buildDesktopChatWorkbenchProjection({
      sessions,
      activeSessionKey: "WebSocket:chat-1",
      activeChatId: "chat-1",
      messages,
      responding: false,
      usePersistentRag: true,
      attachments,
    });

    expect(idle.composer).toEqual({
      state: "idle",
      contextChips: [
        { id: "file-readme", label: "README.md", scope: "session", detail: "Attached to this chat" },
        { id: "knowledge-native", label: "Native app docs", scope: "knowledge", detail: "Persistent RAG" },
      ],
      ragToggle: { enabled: true, label: "Knowledge on" },
      controls: ["attach", "toggle-rag", "send"],
    });

    const streaming = buildDesktopChatWorkbenchProjection({
      sessions,
      activeSessionKey: "WebSocket:chat-1",
      activeChatId: "chat-1",
      messages,
      responding: true,
      attachments,
    });

    expect(streaming.composer.controls).toEqual(["attach", "toggle-rag", "interrupt"]);
  });
});
