import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterAttention, buildDesktopTaskCenterItems } from "./desktopTaskCenter";

describe("desktop task center projection", () => {
  test("projects long-running module operations without replacing canonical records", () => {
    const items = buildDesktopTaskCenterItems({
      chatStreams: [
        {
          id: "chat-stream:WebSocket:chat-1",
          title: "Streaming response",
          status: "streaming",
          detail: "Generating answer",
          progress: { completed: 42, total: 100 },
          canonical: { module: "chat", entityId: "WebSocket:chat-1", href: "/chat/chat-1" },
          cancelable: true,
        },
      ],
      providerRefreshes: [
        {
          id: "provider:openai:models",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
      fileOperations: [
        {
          id: "file:workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          detail: "Save conflict",
          canonical: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
          retryable: true,
          diagnostics: "HTTP 409",
        },
      ],
    });

    expect(items.map((item) => `${item.source}:${item.state}:${item.title}`)).toEqual([
      "file:failed:Save AGENTS.md",
      "chat:active:Streaming response",
      "provider:completed:Refresh OpenAI models",
    ]);
    expect(items.find((item) => item.id === "file:workspace:AGENTS.md:save")?.actions.map((action) => action.id)).toEqual([
      "retry",
      "open",
      "inspect",
      "copyDiagnostics",
      "dismiss",
    ]);
    expect(items.find((item) => item.id === "chat-stream:WebSocket:chat-1")?.actions.map((action) => action.id)).toEqual([
      "cancel",
      "open",
      "inspect",
    ]);
  });

  test("keeps terminal and non-cancelable tasks safe by limiting actions", () => {
    const items = buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:export:trace",
          title: "Export trace",
          status: "completed",
          detail: "Saved to selected destination",
          canonical: { module: "workspace", entityId: "trace.json", href: "/workspace" },
        },
        {
          id: "file:workspace:SOUL.md:save",
          title: "Save SOUL.md",
          status: "failed",
          detail: "Protected path",
          canonical: { module: "workspace", entityId: "SOUL.md", href: "/workspace" },
          retryable: false,
          diagnostics: "protected path",
        },
      ],
    });

    expect(items.map((item) => [item.id, item.state, item.tone, item.actions.map((action) => action.id).join(",")])).toEqual([
      ["file:workspace:SOUL.md:save", "failed", "danger", "open,inspect,copyDiagnostics,dismiss"],
      ["file:export:trace", "completed", "complete", "open,dismiss"],
    ]);
  });

  test("summarizes compact task attention and primary actions", () => {
    const items = buildDesktopTaskCenterItems({
      chatStreams: [
        {
          id: "chat:stream",
          title: "Streaming response",
          status: "streaming",
          canonical: { module: "chat", href: "/chat" },
          cancelable: true,
        },
      ],
      fileOperations: [
        {
          id: "file:save",
          title: "Save workspace file",
          status: "failed",
          canonical: { module: "workspace", href: "/workspace" },
          retryable: true,
        },
      ],
    });

    const attention = buildDesktopTaskCenterAttention(items);

    expect(attention.compactLabel).toBe("1 running · 0 blocked · 1 failed");
    expect(attention.autoOpenReason).toBe("failed");
    expect(attention.rows.map((row) => `${row.id}:${row.primaryAction?.id}`)).toEqual([
      "file:save:retry",
      "chat:stream:cancel",
    ]);
  });
});
