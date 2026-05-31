import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";

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
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "indexing",
          detail: "Embedding chunks",
          progress: { completed: 7, total: 12 },
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
      coworkRuns: [
        {
          id: "cowork:session-1",
          title: "Ship task center",
          status: "blocked",
          detail: "1 blocker",
          canonical: { module: "cowork", entityId: "session-1", href: "/cowork" },
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
      gatewayOperations: [
        {
          id: "gateway:start",
          title: "Start Tinybot gateway",
          status: "starting",
          detail: "uv run tinybot gateway",
          canonical: { module: "gateway", href: "/api/status" },
        },
      ],
      approvals: [
        {
          id: "approval:tool-1",
          title: "Approve tool execution",
          status: "waiting",
          detail: "Shell command approval required",
          canonical: { module: "approvals", entityId: "tool-1", href: "/chat/chat-1" },
        },
      ],
    });

    expect(items.map((item) => `${item.source}:${item.state}:${item.title}`)).toEqual([
      "approval:blocked:Approve tool execution",
      "cowork:blocked:Ship task center",
      "file:failed:Save AGENTS.md",
      "chat:active:Streaming response",
      "gateway:active:Start Tinybot gateway",
      "knowledge:active:Index Desktop UX Notes",
      "provider:completed:Refresh OpenAI models",
    ]);
    expect(items.find((item) => item.id === "knowledge:doc-1:index")).toMatchObject({
      progressLabel: "7/12",
      destination: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
    });
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
});
