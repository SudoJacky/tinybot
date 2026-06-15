// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  activateDesktopCommandPaletteResult,
  buildDesktopCommandPaletteResults,
  createDesktopCommandPaletteState,
  installDesktopCommandPalette,
  openDesktopCommandPalette,
} from "./desktopCommandPalette";
import {
  installRootWebUiCommandPaletteSurface,
} from "./desktopRootWebUiWorkbench";
import {
  buildDesktopCommandEntriesFromSidebar,
  buildNativeWorkbenchSidebarModel,
  buildRootWebUiSidebarModel,
} from "./desktopSharedModels";
import { mountCommandPaletteIsland } from "./native-vue/commandPaletteIsland";

describe("desktop command palette", () => {
  test("adapts shared desktop entries into root command search destinations", () => {
    const desktopCommands = buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel());
    const state = createDesktopCommandPaletteState({
      desktopCommands,
    });

    expect(buildDesktopCommandPaletteResults(state, "automations")[0]).toMatchObject({
      group: "Actions",
      title: "Automations",
      destination: { module: "cowork", href: "/cowork" },
    });
    expect(buildDesktopCommandPaletteResults(state, "tools")[0]).toMatchObject({
      group: "Actions",
      title: "Tools",
      destination: { module: "tools", href: "/tools" },
    });
    expect(buildDesktopCommandPaletteResults(state, "settings")[0]).toMatchObject({
      group: "System",
      title: "Settings",
      destination: { module: "command", commandId: "open-settings" },
    });
    expect(buildDesktopCommandPaletteResults(state, "runtime diagnostics")[0]).toMatchObject({
      group: "System",
      title: "Gateway Status",
      destination: { module: "command", commandId: "refresh-gateway-status" },
    });
  });

  test("keeps root and native shared entries searchable for the same core destinations", () => {
    const rootState = createDesktopCommandPaletteState({
      desktopCommands: buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel()),
    });
    const nativeState = createDesktopCommandPaletteState({
      desktopCommands: buildDesktopCommandEntriesFromSidebar(buildNativeWorkbenchSidebarModel()),
    });

    for (const query of ["settings", "runtime diagnostics"]) {
      const rootResult = buildDesktopCommandPaletteResults(rootState, query)[0];
      const nativeResult = buildDesktopCommandPaletteResults(nativeState, query)[0];
      expect(nativeResult).toMatchObject({
        title: rootResult.title,
        destination: rootResult.destination,
      });
    }
    expect(buildDesktopCommandPaletteResults(nativeState, "files")[0]).toMatchObject({
      title: "Files",
      destination: { module: "files", href: "/files" },
    });
    expect(buildDesktopCommandPaletteResults(nativeState, "session file")[0]).toMatchObject({
      title: "Files",
      destination: { module: "command", commandId: "open-files" },
    });
    expect(buildDesktopCommandPaletteResults(nativeState, "tools")[0]?.title).not.toBe("Tools");
  });

  test("groups searchable commands and loaded workbench data", () => {
    const state = createDesktopCommandPaletteState({
      sessions: {
        loaded: true,
        rows: [
          { key: "WebSocket:chat-1", chatId: "chat-1", title: "Plan desktop shell", createdAt: "2026-05-31T09:00:00Z", updatedAt: "2026-05-31T10:00:00Z" },
        ],
      },
      workspaceFiles: {
        loaded: true,
        rows: [
          { path: "docs/desktop-shell.md", exists: true, updatedAt: "2026-05-30T09:00:00Z", meta: "Updated 2026-05-30" },
        ],
      },
      knowledgeDocuments: {
        loaded: true,
        rows: [
          {
            id: "doc-1",
            title: "Desktop UX Notes",
            path: "knowledge/desktop.md",
            category: "design",
            tags: ["ux"],
            chunkCount: 12,
            status: "indexed",
            phaseLabel: "Indexed",
            progressPercent: 100,
            progressDetail: "12 chunks indexed",
            updatedAt: "2026-05-29",
            meta: "indexed / 12 chunks",
          },
        ],
      },
      tools: {
        loaded: true,
        rows: [
          { name: "read_file", displayName: "Read file", description: "Read files", enabled: true, configHint: "", riskHint: "", schemaFields: [], schemaText: "", meta: "enabled", raw: {} },
        ],
      },
      skills: {
        loaded: true,
        rows: [
          { name: "desktop-planner", source: "workspace", available: true, always: false, enabled: true, status: "enabled", deletable: true, meta: "workspace / enabled", raw: {} },
        ],
      },
      coworkSessions: {
        loaded: true,
        rows: [
          {
            id: "cowork-1",
            title: "Ship desktop command palette",
            goal: "Search loaded workbench data",
            status: "running",
            workflow: "Hybrid",
            agentCount: 2,
            activeAgentCount: 1,
            taskProgress: { total: 3, completed: 1, failed: 0, blocked: 0 },
            attention: { total: 0, blockers: 0, pendingReplies: 0, taskIssues: 0, workUnitIssues: 0, agentIssues: 0, approvals: 0, interventions: 0, tone: "normal", label: "On track" },
            finalOutput: "",
            updatedAt: "2026-05-31T11:00:00Z",
            meta: "running / Hybrid",
            raw: {},
          },
        ],
      },
    });

    const shellResults = buildDesktopCommandPaletteResults(state, "desktop");
    expect(shellResults.map((result) => `${result.group}:${result.title}`)).toEqual([
      "Commands:Documentation",
      "Commands:Shortcut Help",
      "Commands:Page Help",
      "Sessions:Plan desktop shell",
      "Workspace files:docs/desktop-shell.md",
      "Knowledge documents:Desktop UX Notes",
      "Skills:desktop-planner",
      "Cowork sessions:Ship desktop command palette",
    ]);
    expect(shellResults.map((result) => result.groupId)).toEqual([
      "commands",
      "commands",
      "commands",
      "sessions",
      "workspaceFiles",
      "knowledgeDocuments",
      "skills",
      "coworkSessions",
    ]);

    const skillsResults = buildDesktopCommandPaletteResults(state, "read");
    expect(skillsResults.map((result) => `${result.group}:${result.title}`)).toEqual([
      "Tools:Read file",
    ]);

    const skillResult = buildDesktopCommandPaletteResults(state, "planner")[0];
    expect(skillResult).toMatchObject({
      groupId: "skills",
      group: "Skills",
      title: "desktop-planner",
      destination: { module: "skills", entityId: "desktop-planner" },
    });
  });

  test("reports unloaded groups without fabricating searchable results", () => {
    const state = createDesktopCommandPaletteState();

    expect(new Set(buildDesktopCommandPaletteResults(state, "session").map((result) => result.group))).toEqual(new Set(["Commands"]));
    expect(state.groups.filter((group) => !group.loaded).map((group) => group.label)).toEqual([
      "Sessions",
      "Workspace files",
      "Knowledge documents",
      "Tools",
      "Skills",
      "Cowork sessions",
    ]);
  });

  test("opens with an optional initial query for keyboard-first session search", () => {
    const events: unknown[] = [];
    const targetDocument = {
      dispatchEvent: (event: Event) => {
        events.push((event as CustomEvent).detail);
        return true;
      },
    };

    openDesktopCommandPalette(targetDocument as unknown as Document, "session");

    expect(events).toEqual([{ query: "session" }]);
  });

  test("renders installed command palette results through a Vue island", () => {
    const host = document.createElement("section");
    mountCommandPaletteIsland(host);
    document.body.append(host);

    installDesktopCommandPalette({
      desktopCommands: buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel()),
      targetDocument: document,
      targetWindow: window,
    });

    expect(document.querySelector("#desktop-command-palette-results")?.getAttribute("data-desktop-vue-island")).toBe("command-palette-results");
    expect(document.querySelector("[data-palette-result-id]")?.textContent).toContain("New");

    host.remove();
  });

  test("mounts the root WebUI command palette shell through a Vue island", () => {
    document.body.replaceChildren();

    installRootWebUiCommandPaletteSurface(document);
    installRootWebUiCommandPaletteSurface(document);

    const palette = document.getElementById("desktop-command-palette");
    expect(document.body.querySelectorAll("#desktop-command-palette")).toHaveLength(1);
    expect(palette?.getAttribute("data-desktop-vue-island")).toBe("command-palette");
    expect(palette?.getAttribute("role")).toBe("dialog");
    expect(document.getElementById("desktop-command-palette-input")?.getAttribute("aria-label")).toBe("Search commands and workbench data");
    expect(document.getElementById("desktop-command-palette-results")?.getAttribute("aria-live")).toBe("polite");
  });

  test("activates quick-search results by navigating and focusing matching entities", () => {
    const focused: string[] = [];
    const events: Array<{ type: string; detail: unknown }> = [];
    const focusTarget = {
      focus: () => focused.push("files:docs/desktop-shell.md"),
    };
    const targetDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: (selector: string) =>
        selector === '[data-desktop-entity-module="files"][data-desktop-entity-id="docs/desktop-shell.md"]'
          ? focusTarget
          : null,
      dispatchEvent: (event: Event) => {
        events.push({ type: event.type, detail: (event as CustomEvent).detail });
        return true;
      },
    };
    const historyCalls: string[] = [];
    const targetWindow = {
      location: { origin: "http://localhost:1420" },
      history: {
        pushState: (_state: unknown, _title: string, href: string) => historyCalls.push(href),
      },
      dispatchEvent: (event: Event) => {
        events.push({ type: event.type, detail: (event as CustomEvent).detail });
        return true;
      },
    };

    activateDesktopCommandPaletteResult(
      {
        id: "workspace:docs/desktop-shell.md",
        groupId: "workspaceFiles",
        group: "Workspace files",
        title: "docs/desktop-shell.md",
        secondary: "Updated",
        keywords: [],
        destination: { module: "files", entityId: "docs/desktop-shell.md", href: "/files" },
      },
      {
        gatewayOrigin: "http://127.0.0.1:18790",
        targetDocument: targetDocument as unknown as Document,
        targetWindow: targetWindow as unknown as Window,
      },
    );

    expect(historyCalls).toEqual(["http://localhost:1420/files"]);
    expect(focused).toEqual(["files:docs/desktop-shell.md"]);
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("files");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusEntity).toBe("docs/desktop-shell.md");
    expect(targetDocument.documentElement.dataset.desktopCommandFeedback).toBe("Focused Workspace files: docs/desktop-shell.md");
    expect(events.map((event) => event.type)).toContain("tinybot:desktop-route");
    expect(events.map((event) => event.type)).toContain("tinybot:desktop-palette-activate");
  });

  test("keeps focus intent when selected result needs data that is not mounted yet", () => {
    const targetDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: () => null,
      dispatchEvent: () => true,
    };
    const targetWindow = {
      location: { origin: "http://localhost:1420" },
      history: { pushState: () => undefined },
      dispatchEvent: () => true,
    };

    activateDesktopCommandPaletteResult(
      {
        id: "skill:desktop-planner",
        groupId: "skills",
        group: "Skills",
        title: "desktop-planner",
        secondary: "workspace / enabled",
        keywords: [],
        destination: { module: "skills", entityId: "desktop-planner", href: "/tools" },
      },
      {
        gatewayOrigin: "http://127.0.0.1:18790",
        targetDocument: targetDocument as unknown as Document,
        targetWindow: targetWindow as unknown as Window,
      },
    );

    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("skills");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusEntity).toBe("desktop-planner");
    expect(targetDocument.documentElement.dataset.desktopCommandFeedback).toBe("Open Skills: desktop-planner");
  });
});
