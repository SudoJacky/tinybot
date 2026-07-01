// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  activateDesktopCommandPaletteResult,
  buildDesktopCommandPaletteResults,
  createDesktopCommandPaletteState,
  installDesktopCommandPalette,
  openDesktopCommandPalette,
} from "./desktopCommandPalette";
import { resolveDesktopShortcutCommand } from "./desktopCommandNavigation";
import {
  installRootWebUiCommandPaletteSurface,
} from "../root-webui/desktopRootWebUiWorkbench";
import {
  buildDesktopCommandEntriesFromSidebar,
  buildNativeWorkbenchSidebarModel,
  buildRootWebUiSidebarModel,
} from "../shell/desktopSharedModels";
import { mountCommandPaletteIsland } from "../components/shared/commandPaletteIsland";

describe("desktop command palette", () => {
  test("adapts shared desktop entries into root command search destinations", () => {
    const desktopCommands = buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel());
    const state = createDesktopCommandPaletteState({
      desktopCommands,
    });

    expect(buildDesktopCommandPaletteResults(state, "automations")).toEqual([]);
    expect(buildDesktopCommandPaletteResults(state, "tools")).toEqual([]);
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
    expect(buildDesktopCommandPaletteResults(nativeState, "files")).toEqual([]);
    expect(buildDesktopCommandPaletteResults(nativeState, "session file")).toEqual([]);
    expect(buildDesktopCommandPaletteResults(nativeState, "tools")[0]?.title).not.toBe("Tools");
  });

  test("groups searchable commands and loaded chat sessions only", () => {
    const state = createDesktopCommandPaletteState({
      sessions: {
        loaded: true,
        rows: [
          { key: "WebSocket:chat-1", chatId: "chat-1", title: "Plan desktop shell", createdAt: "2026-05-31T09:00:00Z", updatedAt: "2026-05-31T10:00:00Z" },
        ],
      },
    });

    const shellResults = buildDesktopCommandPaletteResults(state, "desktop");
    expect(shellResults.map((result) => `${result.group}:${result.title}`)).toEqual([
      "Commands:Documentation",
      "Commands:Shortcut Help",
      "Commands:Page Help",
      "Sessions:Plan desktop shell",
    ]);
    expect(shellResults.map((result) => result.groupId)).toEqual([
      "commands",
      "commands",
      "commands",
      "sessions",
    ]);

    const skillsResults = buildDesktopCommandPaletteResults(state, "read");
    expect(skillsResults).toEqual([]);
    expect(buildDesktopCommandPaletteResults(state, "planner")).toEqual([]);
  });

  test("ignores removed knowledge input data", () => {
    const state = createDesktopCommandPaletteState({
      knowledgeDocuments: {
        loaded: true,
        rows: [
          {
            id: "doc-1",
            title: "Desktop Notes",
            path: "knowledge/desktop.md",
            category: "design",
            tags: ["notes"],
            chunkCount: 2,
            status: "indexed",
            phaseLabel: "Indexed",
            progressPercent: 100,
            progressDetail: "2 chunks indexed",
            updatedAt: "2026-06-01",
            meta: "indexed / 2 chunks",
          },
        ],
      },
    }, {
      activeModule: "knowledge",
      recentEntityIds: ["doc-1"],
    });

    expect(buildDesktopCommandPaletteResults(state, "desktop notes")).toEqual([]);
  });

  test("maps Ctrl/Cmd+K to command palette without removing Ctrl+Shift+P", () => {
    expect(resolveDesktopShortcutCommand({ key: "k", ctrlKey: true })).toBe("open-command-palette");
    expect(resolveDesktopShortcutCommand({ key: "k", metaKey: true })).toBe("open-command-palette");
    expect(resolveDesktopShortcutCommand({ key: "p", ctrlKey: true, shiftKey: true })).toBe("open-command-palette");
  });

  test("reports unloaded groups without fabricating searchable results", () => {
    const state = createDesktopCommandPaletteState();

    expect(new Set(buildDesktopCommandPaletteResults(state, "session").map((result) => result.group))).toEqual(new Set(["Commands"]));
    expect(state.groups.filter((group) => !group.loaded).map((group) => group.label)).toEqual([
      "Sessions",
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
        id: "session:WebSocket:chat-1",
        groupId: "sessions",
        group: "Sessions",
        title: "Desktop shell chat",
        secondary: "Updated",
        keywords: [],
        destination: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
        actions: [{ id: "open", label: "Open" }],
      },
      {
        gatewayOrigin: "http://127.0.0.1:18790",
        targetDocument: targetDocument as unknown as Document,
        targetWindow: targetWindow as unknown as Window,
      },
    );

    expect(historyCalls).toEqual(["http://localhost:1420/chat/chat-1"]);
    expect(focused).toEqual([]);
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("chat");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusEntity).toBe("chat-1");
    expect(targetDocument.documentElement.dataset.desktopCommandFeedback).toBe("Open Sessions: Desktop shell chat");
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
        id: "session:WebSocket:chat-2",
        groupId: "sessions",
        group: "Sessions",
        title: "Deferred chat",
        secondary: "recent",
        keywords: [],
        destination: { module: "chat", entityId: "chat-2", href: "/chat/chat-2" },
        actions: [{ id: "open", label: "Open" }],
      },
      {
        gatewayOrigin: "http://127.0.0.1:18790",
        targetDocument: targetDocument as unknown as Document,
        targetWindow: targetWindow as unknown as Window,
      },
    );

    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("chat");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusEntity).toBe("chat-2");
    expect(targetDocument.documentElement.dataset.desktopCommandFeedback).toBe("Open Sessions: Deferred chat");
  });
});
