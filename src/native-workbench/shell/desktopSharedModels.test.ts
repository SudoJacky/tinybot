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
    expect(entries.find((entry) => entry.commandId === "open-command-palette")).toMatchObject({
      title: "Command Palette",
      group: "Actions",
    });
    expect(entries.map((entry) => entry.href)).not.toEqual(expect.arrayContaining(["/tools", "/cowork"]));
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

  test("defines the native workbench IA as Chat and Settings only", () => {
    expect(buildWorkbenchWorkbenchAreas().map((area) => [area.id, area.label, area.href, area.owner])).toEqual([
      ["chat", "Chat", "/chat", "Daily AI execution and conversation work items"],
      ["settings", "Settings", "/settings", "Providers, models, runtime, and diagnostics"],
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
    expect(buildWorkbenchInspectorTabs({ activePage: "settings" }).find((tab) => tab.active)).toMatchObject({
      id: "activity",
    });
  });

  test("defines chat-first settings sections and phased roadmap gates", () => {
    expect(buildWorkbenchSettingsSections().map((section) => [section.id, section.label, section.href])).toEqual([
      ["general", "General", "/settings/general"],
      ["provider-models", "Provider & Models", "/settings/provider-models"],
      ["gateway-runtime", "Gateway & Runtime", "/settings/gateway-runtime"],
      ["logs-diagnostics", "Logs & Diagnostics", "/settings/logs-diagnostics"],
    ]);
    expect(buildNativeWorkbenchRoadmap().map((phase) => [phase.id, phase.title, phase.exitCriteria])).toEqual([
      ["phase-1", "Chat foundation", "Chat, Settings, runtime status, and provider basics are usable together."],
      ["phase-2", "Agent execution clarity", "Run timeline, approvals, forms, references, and token usage are inspectable from chat."],
      ["phase-3", "Selective expansion", "Files, Knowledge, Skills, and Cowork only return after the Rust backend exposes stable frontend contracts."],
      ["phase-4", "Advanced workbench capabilities", "Multi-window, tray, channels, memory, automations, and collaboration are planned after core stability."],
    ]);
  });
});
