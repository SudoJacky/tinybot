import { describe, expect, test } from "vitest";
import {
  buildDesktopCommandEntriesFromSidebar,
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
});
