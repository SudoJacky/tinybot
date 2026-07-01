// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";

import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import {
  installDesktopWorkbenchShell,
  updateDesktopNativeChat,
  type DesktopNativeChatModel,
} from "./desktopWorkbenchShell";

describe("desktop chat surface entry", () => {
  test("mounts native chat through the rebuilt projection surface", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: chatFixture("Initial answer"),
    });

    const thread = document.querySelector<HTMLElement>(".desktop-conversation-thread");
    expect(thread?.getAttribute("data-chat-surface")).toBe("rebuild-chat-agent-surface");
    expect(thread?.getAttribute("data-desktop-vue-island")).toBeNull();
    expect(thread?.querySelector("[data-chat-region='session-list']")?.textContent).toContain("Live session");
    expect(thread?.querySelector("[data-chat-turn-id='assistant-1']")?.textContent).toContain("Initial answer");
    expect(thread?.querySelector("[data-chat-region='tool-row']")?.textContent).toContain("workspace.read_file");
    expect(thread?.querySelector(".desktop-conversation-message")).toBeNull();
  });

  test("updates the rebuilt surface from native chat state changes", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: chatFixture("Initial answer"),
    });

    updateDesktopNativeChat(document, chatFixture("Updated answer"));

    const thread = document.querySelector<HTMLElement>(".desktop-conversation-thread");
    expect(thread?.getAttribute("data-chat-surface")).toBe("rebuild-chat-agent-surface");
    expect(thread?.querySelector("[data-chat-turn-id='assistant-1']")?.textContent).toContain("Updated answer");
  });
});

function chatFixture(answer: string): DesktopNativeChatModel {
  return {
    activeChatId: "chat-live",
    activeSessionKey: "WebSocket:chat-live",
    messages: [{
      role: "assistant",
      content: answer,
      reasoningContent: "Reading project files",
      timestamp: "2026-07-01T10:00:00.000Z",
      messageId: "assistant-1",
      toolActivities: [{
        id: "tool-1",
        kind: "call",
        name: "workspace.read_file",
        status: "completed",
        argsText: "{\"path\":\"README.md\"}",
        responseText: "file contents",
      }],
    }],
    sessions: [{
      chatId: "chat-live",
      createdAt: "2026-07-01T09:00:00.000Z",
      key: "WebSocket:chat-live",
      title: "Live session",
      updatedAt: "2026-07-01T10:00:00.000Z",
    }],
  };
}
