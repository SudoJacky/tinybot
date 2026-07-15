import { describe, expect, test } from "vitest";
import {
  buildDesktopChatSessionUx,
  buildDesktopCommandPaletteUx,
  buildDesktopCoworkCockpitUx,
  buildDesktopFileLifecycleUx,
  buildDesktopLoadingPerformanceUx,
  buildDesktopSafeModeRecoveryUx,
  buildDesktopSettingsProviderSetupUx,
  buildDesktopTaskCenterAttentionUx,
  buildDesktopToolsSkillsManagementUx,
  buildDesktopWorkbenchShellUx,
} from "./desktopNativeUx";

describe("desktop native UX projections", () => {
  test("maps startup and gateway states to safe-mode recovery actions", () => {
    const ready = buildDesktopSafeModeRecoveryUx({
      phase: "ready",
      owner: "external",
      routeIntent: { href: "/chat/session-1", sessionId: "session-1" },
    });
    expect(ready.progressSteps.map((step) => `${step.id}:${step.state}`)).toEqual([
      "start:complete",
      "connect:complete",
      "workspace:complete",
      "ready:complete",
    ]);
    expect(ready.diagnosticsDefaultOpen).toBe(false);
    expect(ready.summary).toBe("Using an existing gateway");
    expect(ready.safeModeAction.href).toBe("/?route=%2Fchat%2Fsession-1&session=session-1");

    const incompatible = buildDesktopSafeModeRecoveryUx({
      phase: "failed",
      failureType: "bootstrap-incompatible",
      responseClass: "html",
    });
    expect(incompatible.diagnosticsDefaultOpen).toBe(true);
    expect(incompatible.recoveryCards[0]).toMatchObject({
      id: "bootstrap-incompatible",
      primaryAction: "Open native workbench",
    });
    expect(incompatible.recoveryCards[0].hint).toContain("not with the WebUI bootstrap shape");
  });

  test("defines workbench shell regions, attention badges, inspector tabs, and contextual help", () => {
    const shell = buildDesktopWorkbenchShellUx({
      activeModule: "workspace",
      selectedEntityId: "doc-1",
      hiddenPanels: ["inspector", "bottom"],
      attention: { taskUpdates: 2, references: 1, blocked: 1, failed: 0 },
      routeHydrating: true,
      theme: "dark",
      language: "zh-CN",
    });
    expect(shell.regions.map((region) => region.id)).toEqual(["activity-rail", "module-sidebar", "main-work", "inspector", "task-center"]);
    expect(shell.hiddenPanelBadges.map((badge) => badge.label)).toEqual(["2 task updates", "1 reference selected", "1 blocked"]);
    expect(shell.skeleton?.label).toBe("Loading Workspace");
    expect(shell.inspectorTabs.map((tab) => tab.id)).toEqual(["overview", "tools", "references", "files", "raw"]);
    expect(shell.contextualHelp.href).toBe("/docs/webui");
    expect(shell.preferenceBridge).toEqual({ theme: "dark", language: "zh-CN" });
  });

  test("projects chat starters, session groups, attachment labels, and streaming behavior", () => {
    const chat = buildDesktopChatSessionUx({
      sessions: [
        { key: "s1", title: "Pinned", pinned: true, status: "idle" },
        { key: "s2", title: "Running", status: "running" },
        { key: "s3", title: "Approval", status: "approval_required" },
      ],
      attachments: [
        { id: "tmp-1", source: "session", title: "notes.txt" },
        { id: "file-1", source: "workspace", title: "AGENTS.md" },
      ],
      responding: false,
      scroll: { distanceFromBottom: 160, viewportHeight: 800 },
      activities: [{ id: "tool-1", kind: "tool", label: "Read file" }],
    });
    expect(chat.starters.map((starter) => starter.id)).toEqual(["ask", "analyze-file", "plan-cowork", "edit-workspace-file"]);
    expect(chat.sessionGroups.map((group) => `${group.id}:${group.sessions.map((session) => session.key).join(",")}`)).toEqual([
      "pinned:s1",
      "running:s2,s3",
      "recent:",
    ]);
    expect(chat.attachmentChips.map((chip) => `${chip.sourceLabel}:${chip.title}`)).toEqual([
      "session file:notes.txt",
      "workspace file:AGENTS.md",
    ]);
    expect(chat.stopGeneration.primary).toBe(false);
    expect(chat.streaming.keepAnchoredToBottom).toBe(false);
    expect(chat.activityChips[0]).toMatchObject({ opensInspector: true });
  });

  test("summarizes task-center attention and approval actions", () => {
    const attention = buildDesktopTaskCenterAttentionUx([
      { id: "a", state: "active", source: "chat", title: "Streaming", actions: [{ id: "cancel", label: "Cancel" }] },
      { id: "b", state: "blocked", source: "approval", title: "Approve", actions: [{ id: "approveOnce", label: "Approve once" }] },
      { id: "c", state: "failed", source: "file", title: "Save failed", actions: [{ id: "retry", label: "Retry" }] },
      { id: "d", state: "completed", source: "provider", title: "Refreshed", actions: [{ id: "open", label: "Open" }] },
    ]);
    expect(attention.compactLabel).toBe("1 running · 1 blocked · 1 failed");
    expect(attention.autoOpenReason).toBe("blocked");
    expect(attention.rows.map((row) => `${row.id}:${row.primaryAction?.id}`)).toEqual(["b:approveOnce", "c:retry", "a:cancel", "d:open"]);
    expect(attention.notificationPolicy({ appFocused: true }).shouldNotify).toBe(false);
    expect(attention.notificationPolicy({ appFocused: false }).deepLink?.entityId).toBe("b");
  });

  test("adds command palette shortcuts, ranking, and result actions", () => {
    const palette = buildDesktopCommandPaletteUx({
      platform: "darwin",
      query: "desktop notes",
      results: [
        { id: "system", groupId: "commands", title: "Documentation", keywords: ["desktop"], updatedAt: "", activeModule: false },
        { id: "doc", groupId: "workspaceFiles", title: "Desktop Notes", keywords: ["desktop", "notes"], updatedAt: "2026-06-01", activeModule: true },
      ],
    });
    expect(palette.shortcuts).toContain("Cmd+K");
    expect(palette.results[0]).toMatchObject({ id: "doc" });
    expect(palette.results[0].actions.map((action) => action.id)).toEqual(["open", "focus", "reveal"]);
    expect(palette.refreshPolicy).toMatchObject({ debounceMs: 180, keepCachedResults: true });
  });

  test("models settings first-run provider setup and scoped discovery state", () => {
    const settings = buildDesktopSettingsProviderSetupUx({
      hasUsableProvider: false,
      dirty: true,
      providerSecrets: [{ providerId: "openai", configured: true, masked: true }],
      modelDiscovery: [{ providerId: "openai", status: "failed", message: "401" }],
    });
    expect(settings.firstRun.required).toBe(true);
    expect(settings.firstRun.steps.map((step) => step.id)).toEqual(["choose-provider", "enter-key", "test-connection", "pick-default-model", "start-chat"]);
    expect(settings.intentGroups.map((group) => group.id)).toEqual(["ai-provider-model", "workspace-files", "tools-skills", "gateway-runtime", "diagnostics", "advanced"]);
    expect(settings.secretStates[0].label).toBe("Saved key will be reused");
    expect(settings.modelDiscoveryByProvider.openai.status).toBe("failed");
    expect(settings.unsavedBar.actions).toEqual(["Save", "Reset", "Test connection"]);
  });

  test("clarifies file lifecycles and workspace conflict actions", () => {
    const files = buildDesktopFileLifecycleUx({
      destination: "session",
      file: { name: "large.bin", size: 50 * 1024 * 1024, type: "application/octet-stream" },
      workspaceState: "conflict",
      temporarySessionFile: true,
      operation: "save",
    });
    expect(files.destinationCopy).toBe("Attach to this conversation");
    expect(files.validation.accepted).toBe(false);
    expect(files.validation.reason).toContain("size");
    expect(files.workspaceStatus.label).toBe("Conflict detected");
    expect(files.workspaceStatus.actions).toEqual(["Keep mine", "Reload theirs", "Compare changes"]);
    expect(files.temporaryLifecycleText).toBe("Available to this chat session.");
    expect(files.toast?.actions).toEqual(["Reveal", "Copy path", "Open folder"]);
  });

  test("groups tools and skills with risk, validation, and delete safeguards", () => {
    const toolsSkills = buildDesktopToolsSkillsManagementUx({
      tools: [
        { name: "exec_shell", description: "Run command", riskHint: "Requires approval", enabled: true },
        { name: "memory_search", description: "Search memory", riskHint: "", enabled: true },
      ],
      skills: [
        { name: "planner", enabled: true, always: false, available: true, status: "needs_validation", deletable: true },
      ],
    });
    expect(toolsSkills.conceptCopy.tools).toContain("assistant can call");
    expect(toolsSkills.toolGroups.map((group) => group.id)).toContain("requires-approval");
    expect(toolsSkills.toolGroups.find((group) => group.id === "execution")?.tools[0].name).toBe("exec_shell");
    expect(toolsSkills.skillRows[0].badges).toEqual(["Enabled", "Needs validation"]);
    expect(toolsSkills.editorActions.map((action) => action.id)).toEqual(["validate", "previewDiff", "exampleInvocation", "dryRun"]);
    expect(toolsSkills.deleteConfirmation.requiredText).toBe("planner");
  });

  test("stages Cowork cockpit readiness, confirmations, graph focus, and handoff", () => {
    const cowork = buildDesktopCoworkCockpitUx({
      nativeReady: false,
      selected: { type: "task", id: "task-1" },
      session: { id: "cowork-1", status: "running", finalDraft: "Draft" },
    });
    expect(cowork.readiness.mode).toBe("preview");
    expect(cowork.readiness.fallbackHref).toBe("/cowork");
    expect(cowork.stages.map((stage) => stage.id)).toEqual(["goal", "plan", "run", "review-outputs", "finalize"]);
    expect(cowork.primarySurface).toBe("timeline-task-feed");
    expect(cowork.graphFocus.rootId).toBe("task-1");
    expect(cowork.confirmations.map((item) => item.action)).toContain("selectFinalResult");
    expect(cowork.handoffActions.map((action) => action.id)).toEqual(["insertSummaryIntoChat", "saveFinalDraftToWorkspace", "exportTrace", "createFollowUpTask"]);
  });

  test("defines loading boundaries, virtualization, memoization, and measurement hooks", () => {
    const performance = buildDesktopLoadingPerformanceUx({
      route: "chat",
      longListCounts: { sessions: 120, taskRows: 80, coworkTraces: 0 },
    });
    expect(performance.immediate).toEqual(["startup-shell", "chat-shell", "composer", "session-list-metadata", "task-center-shell", "command-palette-shell"]);
    expect(performance.lazy).toContain("cowork-cockpit");
    expect(performance.routeHydration.skeleton).toBe("Chat skeleton");
    expect(performance.virtualization.sessions.enabled).toBe(true);
    expect(performance.memoizedProjections).toEqual(["run-chain-items", "task-center-items", "command-palette-data"]);
    expect(performance.measurements.map((metric) => metric.id)).toEqual([
      "first-usable-composer",
      "first-session-list",
      "command-palette-open-latency",
      "streaming-frame-drops",
      "route-hydration-time",
      "graph-memory-after-open",
    ]);
  });
});
