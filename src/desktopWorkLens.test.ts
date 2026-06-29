import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import {
  buildDesktopWorkLensProjection,
  type DesktopWorkLensRelatedResourceInput,
} from "./desktopWorkLens";

describe("desktop work lens projection", () => {
  test("projects a chat run from task-center state and run-chain resources", () => {
    const [task] = buildDesktopTaskCenterItems({
      chatStreams: [
        {
          id: "chat:session-1:run-7",
          title: "Streaming answer",
          status: "streaming",
          detail: "Using workspace files",
          progress: { percent: 42 },
          canonical: { module: "chat", entityId: "session-1", href: "/chat/session-1" },
          cancelable: true,
        },
      ],
    });
    const resources: DesktopWorkLensRelatedResourceInput[] = [
      {
        kind: "tool",
        id: "tool:web.run",
        title: "web.run",
        detail: "Search evidence",
        route: { module: "chat", entityId: "session-1", href: "/chat/session-1" },
      },
      {
        kind: "file",
        id: "file:AGENTS.md",
        title: "AGENTS.md",
        detail: "Workspace context",
        route: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
      },
    ];

    const lens = buildDesktopWorkLensProjection({ task, resources });

    expect(lens).toMatchObject({
      mode: "ready",
      kind: "chatRun",
      id: "chat:session-1:run-7",
      title: "Streaming answer",
      state: "active",
      stateReason: "Using workspace files",
      canonicalRoute: { module: "chat", entityId: "session-1", href: "/chat/session-1" },
    });
    expect(lens.sections.map((section) => section.id)).toEqual(["happening", "used", "changed", "next"]);
    expect(lens.sections.find((section) => section.id === "happening")?.rows).toContainEqual({
      label: "Progress",
      value: "42%",
    });
    expect(lens.relatedResources.map((resource) => `${resource.kind}:${resource.title}`)).toEqual([
      "tool:web.run",
      "file:AGENTS.md",
    ]);
    expect(lens.nextActions.map((action) => action.id)).toEqual(["cancel", "open", "inspect"]);
  });

  test("projects failed knowledge work with evidence resources and diagnostics actions", () => {
    const [task] = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429: rate limit",
        },
      ],
    });

    const lens = buildDesktopWorkLensProjection({
      task,
      resources: [
        {
          kind: "evidence",
          id: "evidence:doc-1:claim-2",
          title: "Claim evidence",
          detail: "docs/desktop.md line 42",
          route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
      outputs: [
        {
          kind: "diagnostic",
          id: "diagnostic:knowledge:doc-1:index",
          title: "Failure diagnostics",
          detail: "HTTP 429: rate limit",
          route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
    });

    expect(lens.kind).toBe("knowledgeJob");
    expect(lens.state).toBe("failed");
    expect(lens.relatedResources).toHaveLength(1);
    expect(lens.outputs).toHaveLength(1);
    expect(lens.nextActions.map((action) => action.id)).toEqual(["retry", "open", "inspect", "copyDiagnostics"]);
    expect(lens.nextActions.find((action) => action.id === "copyDiagnostics")).toMatchObject({
      diagnosticText: "HTTP 429: rate limit",
    });
  });

  test("uses task-center related resources and outputs when no explicit lens resources are passed", () => {
    const [task] = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-2:index",
          title: "Rebuild source evidence",
          status: "failed",
          detail: "Source citation mismatch",
          canonical: { module: "knowledge", entityId: "doc-2", href: "/knowledge" },
          retryable: true,
          relatedResources: [
            {
              kind: "evidence",
              id: "evidence:doc-2:claim-1",
              title: "Claim 1 evidence",
              detail: "docs/operators.md line 12",
              route: { module: "knowledge", entityId: "doc-2", href: "/knowledge" },
            },
          ],
          outputs: [
            {
              kind: "diagnostic",
              id: "diagnostic:doc-2",
              title: "Citation mismatch",
              detail: "Missing source span",
              route: { module: "knowledge", entityId: "doc-2", href: "/knowledge" },
            },
          ],
        },
      ],
    });

    const lens = buildDesktopWorkLensProjection({ task });

    expect(lens.relatedResources.map((resource) => resource.id)).toEqual(["evidence:doc-2:claim-1"]);
    expect(lens.outputs.map((resource) => resource.id)).toEqual(["diagnostic:doc-2"]);
    expect(lens.sections.find((section) => section.id === "used")?.rows).toContainEqual({
      label: "Evidence",
      value: "Claim 1 evidence / docs/operators.md line 12",
    });
    expect(lens.sections.find((section) => section.id === "changed")?.rows).toContainEqual({
      label: "Diagnostic",
      value: "Citation mismatch / Missing source span",
    });
  });

  test("projects Cowork blocked work without broad or destructive actions", () => {
    const [task] = buildDesktopTaskCenterItems({
      coworkRuns: [
        {
          id: "cowork:session-9",
          title: "Refine operator workflow",
          status: "intervention-needed",
          detail: "Branch result needs review",
          canonical: { module: "cowork", entityId: "session-9", href: "/cowork" },
          diagnostics: "task-4 blocked by review",
        },
      ],
    });

    const lens = buildDesktopWorkLensProjection({
      task,
      resources: [
        {
          kind: "coworkEntity",
          id: "cowork:session-9:task-4",
          title: "Task 4",
          detail: "Needs review",
          route: { module: "cowork", entityId: "session-9", href: "/cowork" },
        },
        {
          kind: "artifact",
          id: "artifact:final-draft",
          title: "Final draft",
          detail: "Produced by branch B",
          route: { module: "cowork", entityId: "session-9", href: "/cowork" },
        },
      ],
    });

    expect(lens.kind).toBe("coworkRun");
    expect(lens.state).toBe("blocked");
    expect(lens.nextActions.map((action) => action.id)).toEqual(["open", "inspect", "copyDiagnostics"]);
    expect(lens.nextActions.some((action) => action.id === "dismiss")).toBe(false);
    expect(lens.relatedResources.map((resource) => resource.kind)).toEqual(["coworkEntity", "artifact"]);
  });

  test("falls back for unsupported task-center sources", () => {
    const [task] = buildDesktopTaskCenterItems({
      providerRefreshes: [
        {
          id: "provider:openai:models",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
    });

    const lens = buildDesktopWorkLensProjection({ task });

    expect(lens).toMatchObject({
      mode: "fallback",
      fallbackReason: "unsupported-source",
      title: "Refresh OpenAI models",
      canonicalRoute: { module: "settings", entityId: "openai", href: "/settings" },
    });
    expect(lens.nextActions.map((action) => action.id)).toEqual(["open"]);
  });

  test("filters task-center approval actions from work lens projections", () => {
    const [task] = buildDesktopTaskCenterItems({
      approvals: [
        {
          id: "approval:tool-1",
          title: "Approve shell command",
          status: "requires_approval",
          detail: "Tool call needs permission",
          canonical: { module: "approvals", entityId: "tool-1", href: "/tools/approvals/tool-1" },
          approval: { approvalId: "tool-1", sessionKey: "WebSocket:chat-1" },
        },
      ],
    });

    const lens = buildDesktopWorkLensProjection({ task });

    expect(task.actions.map((action) => action.id)).toEqual(["approveOnce", "approveSession", "deny", "open", "inspect"]);
    expect(lens.nextActions.map((action) => action.id)).toEqual(["open"]);
  });
});
