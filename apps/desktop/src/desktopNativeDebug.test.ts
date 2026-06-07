// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { createDesktopNativeWorkbenchRuntime } from "./desktopNativeWorkbenchRuntime";
import { logDesktopNativeDebug } from "./desktopNativeChatDebug";
import { DEFAULT_GATEWAY_CONFIG } from "./gatewayConfig";
import { createGatewayApiClient } from "./gatewayHttpClient";

describe("desktop native debug logger", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.__tinybotNativeDebug = [];
    window.__tinybotNativeChatDebug = [];
    vi.restoreAllMocks();
  });

  test("stores sanitized native debug entries behind the localStorage switch", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");

    logDesktopNativeDebug("session.delete.start", {
      longText: "x".repeat(540),
      manyItems: Array.from({ length: 20 }, (_, index) => index),
      nested: { value: "ready" },
    });

    expect(window.__tinybotNativeDebug).toHaveLength(1);
    expect(window.__tinybotNativeChatDebug).toBe(window.__tinybotNativeDebug);
    expect(window.__tinybotNativeDebug?.[0]).toMatchObject({
      stage: "session.delete.start",
      details: {
        longText: `${"x".repeat(500)}...`,
        manyItems: Array.from({ length: 12 }, (_, index) => index),
        nested: { value: "ready" },
      },
    });
    expect(info).toHaveBeenCalledWith("[Tinybot native]", "session.delete.start", window.__tinybotNativeDebug?.[0]?.details);
  });

  test("logs meaningful runtime and session stages for native chat operations", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    const deleted: string[] = [];
    let sessions = [
      { key: "WebSocket:chat-1", chat_id: "chat-1", title: "First chat" },
      { key: "WebSocket:chat-2", chat_id: "chat-2", title: "Second chat" },
    ];
    const runtime = createDesktopNativeWorkbenchRuntime({
      api: {
        listSessions: async () => ({ items: sessions }),
        loadMessages: async (key: string) => ({
          messages: [{ role: "assistant", content: `loaded ${key}`, message_id: `m-${key}` }],
        }),
        deleteSession: async (key: string) => {
          deleted.push(key);
          sessions = sessions.filter((session) => session.key !== key);
          return { deleted: true };
        },
      },
      sendSocketMessage: () => undefined,
    });

    await runtime.loadInitialChatState();
    runtime.submitComposerMessage("Inspect logs");
    await runtime.deleteChatSession("WebSocket:chat-1");

    const stages = window.__tinybotNativeDebug?.map((entry) => entry.stage) ?? [];
    expect(stages).toEqual(expect.arrayContaining([
      "runtime.load.start",
      "runtime.load.complete",
      "runtime.submit",
      "session.load.start",
      "session.load.complete",
      "session.select.start",
      "session.delete.start",
      "session.delete.complete",
    ]));
    expect(deleted).toEqual(["WebSocket:chat-1"]);
    expect(info).toHaveBeenCalled();
  });

  test("logs gateway HTTP request lifecycle without storing request bodies", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
    });

    await client.knowledge.query({ query: "sensitive long query", top_k: 5 });

    const entries = window.__tinybotNativeDebug ?? [];
    expect(entries.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      "gateway.bootstrap.start",
      "gateway.bootstrap.complete",
      "gateway.http.request",
      "gateway.http.response",
    ]));
    expect(entries.find((entry) => entry.stage === "gateway.http.request")?.details).toMatchObject({
      method: "POST",
      path: "/v1/knowledge/query",
    });
    expect(JSON.stringify(entries)).not.toContain("sensitive long query");
  });
});
