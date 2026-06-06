import { describe, expect, test } from "vitest";
import {
  buildDesktopCommandEntriesFromSidebar,
  buildNativeWorkbenchSidebarModel,
  buildNativeWorkbenchRoadmap,
  buildWorkbenchFileScopeLabel,
  buildWorkbenchInspectorTabs,
  buildWorkbenchSettingsSections,
  buildWorkbenchWorkbenchAreas,
  buildRootWebUiRuntimeChips,
  buildRootWebUiSidebarModel,
  buildRootWebUiWorkspaceContext,
  type DesktopSidebarItem,
} from "./desktopSharedModels";

describe("desktop shared shell models", () => {
  test("builds root WebUI workspace context with an optional active session", () => {
    const context = buildRootWebUiWorkspaceContext({
      workspaceId: "workspace:tinybot",
      workspaceLabel: "tinybot",
      activeSession: {
        id: "session-1",
        title: "Desktop shell planning",
        meta: "2m ago",
      },
    });

    expect(context).toEqual({
      id: "workspace:tinybot",
      label: "tinybot",
      mode: "root-webui",
      activeSession: {
        id: "session-1",
        title: "Desktop shell planning",
        meta: "2m ago",
      },
    });
  });

  test("builds root WebUI sidebar groups for actions, workspace sessions, and footer actions", () => {
    const sessions: DesktopSidebarItem[] = [
      {
        id: "session:chat-1",
        kind: "session",
        label: "Plan shell",
        meta: "4m",
        active: true,
      },
    ];
    const model = buildRootWebUiSidebarModel({
      workspace: buildRootWebUiWorkspaceContext({ workspaceLabel: "tinybot" }),
      sessions,
    });

    expect(model.mode).toBe("root-webui");
    expect(model.groups.map((group) => group.id)).toEqual(["actions", "workspace", "footer"]);
    expect(model.groups[0].items.map((item) => item.commandId ?? item.href)).toEqual([
      "new-chat",
      "search-sessions",
      "open-command-palette",
      "/tools",
      "/cowork",
    ]);
    expect(model.groups[1]).toMatchObject({
      id: "workspace",
      label: "tinybot",
      items: sessions,
    });
    expect(model.groups[2].items.map((item) => item.commandId)).toEqual([
      "open-settings",
      "refresh-gateway-status",
      "open-docs",
    ]);
  });

  test("builds compact runtime chips from root WebUI status values", () => {
    expect(
      buildRootWebUiRuntimeChips({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        websocketConnected: true,
        tokenUsage: "42%",
      }),
    ).toEqual([
      { id: "provider", label: "Provider", value: "deepseek", tone: "ok" },
      { id: "model", label: "Model", value: "deepseek-v4-flash", tone: "ok" },
      { id: "websocket", label: "WebSocket", value: "Connected", tone: "ok" },
      { id: "token-usage", label: "Token usage", value: "42%", tone: "ok" },
    ]);
  });

  test("marks missing or disconnected runtime values without dropping chips", () => {
    expect(buildRootWebUiRuntimeChips({ websocketConnected: false }).map((chip) => [chip.id, chip.value, chip.tone])).toEqual([
      ["provider", "-", "muted"],
      ["model", "-", "muted"],
      ["websocket", "Disconnected", "warn"],
      ["token-usage", "-", "muted"],
    ]);
  });

  test("derives command entries from sidebar models for root WebUI and native reuse", () => {
    const entries = buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel());

    expect(entries.map((entry) => entry.id)).toContain("sidebar:command:new-chat");
    expect(entries.map((entry) => entry.id)).toContain("sidebar:link:tools");
    expect(entries.find((entry) => entry.commandId === "open-command-palette")).toMatchObject({
      title: "Command Palette",
      group: "Actions",
    });
    expect(entries.find((entry) => entry.href === "/tools")?.keywords).toEqual(
      expect.arrayContaining(["tools", "actions", "tinybot"]),
    );
  });

  test("builds native workbench sidebar groups from the shared desktop model shape", () => {
    const model = buildNativeWorkbenchSidebarModel();

    expect(model.mode).toBe("native-workbench");
    expect(model.groups.map((group) => group.id)).toEqual(["actions", "workspace", "footer"]);
    expect(model.groups[0].items.map((item) => item.commandId)).toEqual([
      "new-chat",
      "stop-generation",
      "search-sessions",
      "open-command-palette",
    ]);
    expect(buildDesktopCommandEntriesFromSidebar(model).find((entry) => entry.commandId === "stop-generation")).toMatchObject({
      title: "Stop Generation",
      group: "Actions",
    });
    expect(model.groups[1].items.map((item) => [item.label, item.href])).toEqual([
      ["Chat", "/chat"],
      ["Knowledge", "/knowledge"],
      ["Files", "/files"],
      ["Settings", "/settings"],
    ]);
    expect(model.groups[2].items.map((item) => item.commandId)).toEqual([
      "refresh-gateway-status",
      "open-docs",
    ]);
  });

  test("keeps root and native command entries aligned for core desktop destinations", () => {
    const rootEntries = buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel());
    const nativeEntries = buildDesktopCommandEntriesFromSidebar(buildNativeWorkbenchSidebarModel());
    const rootLookup = new Map(rootEntries.map((entry) => [entry.title, entry]));
    const nativeLookup = new Map(nativeEntries.map((entry) => [entry.title, entry]));

    for (const title of ["New Chat", "Search Sessions", "Command Palette", "Settings", "Gateway Status", "Documentation"]) {
      expect(nativeLookup.get(title)).toMatchObject({
        title,
        commandId: rootLookup.get(title)?.commandId,
      });
      if (title !== "Settings") {
        expect(nativeLookup.get(title)?.href).toBe(rootLookup.get(title)?.href);
      }
    }
    expect(rootLookup.has("Stop Generation")).toBe(false);
    expect(nativeLookup.get("Stop Generation")).toMatchObject({
      title: "Stop Generation",
      commandId: "stop-generation",
    });
  });

  test("defines the initial native workbench IA as Chat, Knowledge, Files, and Settings", () => {
    expect(buildWorkbenchWorkbenchAreas().map((area) => [area.id, area.label, area.href, area.owner])).toEqual([
      ["chat", "Chat", "/chat", "Daily AI execution and conversation work items"],
      ["knowledge", "Knowledge", "/knowledge", "Long-term documents, graph structure, retrieval, and evidence"],
      ["files", "Files", "/files", "Session files, Knowledge documents, and workspace files"],
      ["settings", "Settings", "/settings", "Providers, permissions, runtime, channels, and capability boundaries"],
    ]);
  });

  test("keeps shared file scope terminology distinct across the native workbench", () => {
    expect(buildWorkbenchFileScopeLabel("session")).toEqual({
      id: "session",
      label: "Session file",
      description: "Temporary file attached to the active conversation.",
    });
    expect(buildWorkbenchFileScopeLabel("knowledge")).toEqual({
      id: "knowledge",
      label: "Knowledge document",
      description: "Persisted document indexed for retrieval, graph, and evidence workflows.",
    });
    expect(buildWorkbenchFileScopeLabel("workspace")).toEqual({
      id: "workspace",
      label: "Workspace file",
      description: "Local project file that can be previewed, edited, revealed, or referenced.",
    });
  });

  test("defines stable inspector tabs with badges and page defaults", () => {
    expect(buildWorkbenchInspectorTabs({
      activePage: "chat",
      activityCount: 2,
      approvalCount: 1,
      fileCount: 3,
      taskCount: 4,
    })).toEqual([
      { id: "context", label: "Context", active: true, badge: null },
      { id: "files", label: "Files", active: false, badge: 3 },
      { id: "tasks", label: "Tasks", active: false, badge: 4 },
      { id: "approvals", label: "Approvals", active: false, badge: 1 },
      { id: "activity", label: "Activity", active: false, badge: 2 },
    ]);
    expect(buildWorkbenchInspectorTabs({ activePage: "knowledge" }).find((tab) => tab.active)).toMatchObject({
      id: "activity",
    });
  });

  test("defines final settings sections and phased roadmap gates", () => {
    expect(buildWorkbenchSettingsSections().map((section) => [section.id, section.label, section.href])).toEqual([
      ["general", "General", "/settings/general"],
      ["provider-models", "Provider & Models", "/settings/provider-models"],
      ["knowledge", "Knowledge", "/settings/knowledge"],
      ["tools-approvals", "Tools & Approvals", "/settings/tools-approvals"],
      ["files-workspace", "Files & Workspace", "/settings/files-workspace"],
      ["memory-experience", "Memory & Experience", "/settings/memory-experience"],
      ["skills", "Skills", "/settings/skills"],
      ["channels", "Channels", "/settings/channels"],
      ["automations", "Automations", "/settings/automations"],
      ["gateway-runtime", "Gateway & Runtime", "/settings/gateway-runtime"],
      ["logs-diagnostics", "Logs & Diagnostics", "/settings/logs-diagnostics"],
    ]);
    expect(buildNativeWorkbenchRoadmap().map((phase) => [phase.id, phase.title, phase.exitCriteria])).toEqual([
      ["phase-1", "Skeleton", "Chat, Files, Knowledge, Settings, shell, runtime status, and provider basics are usable together."],
      ["phase-2", "AI execution surfaces", "Tool timeline, approvals, forms, references, token usage, upload jobs, and workspace editor are inspectable."],
      ["phase-3", "Knowledge differentiation", "2D graph, node drawer, evidence paths, conflicts, communities, and graph/table/evidence switching are usable."],
      ["phase-4", "Advanced workbench capabilities", "Skills, channels, memory/experience, automations, Cowork, multi-window, tray, and dependency-gated features are planned after core stability."],
    ]);
  });
});
