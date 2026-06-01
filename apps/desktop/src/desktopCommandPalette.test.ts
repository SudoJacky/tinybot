import { describe, expect, test } from "vitest";
import {
  activateDesktopCommandPaletteResult,
  buildDesktopCommandPaletteResults,
  createDesktopCommandPaletteState,
  openDesktopCommandPalette,
} from "./desktopCommandPalette";

describe("desktop command palette", () => {
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
          { id: "doc-1", title: "Desktop UX Notes", path: "knowledge/desktop.md", category: "design", tags: ["ux"], chunkCount: 12, status: "indexed", updatedAt: "2026-05-29", meta: "indexed / 12 chunks" },
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

  test("activates quick-search results by navigating and focusing matching entities", () => {
    const focused: string[] = [];
    const events: Array<{ type: string; detail: unknown }> = [];
    const focusTarget = {
      focus: () => focused.push("workspace:docs/desktop-shell.md"),
    };
    const targetDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: (selector: string) =>
        selector === '[data-desktop-entity-module="workspace"][data-desktop-entity-id="docs/desktop-shell.md"]'
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
        destination: { module: "workspace", entityId: "docs/desktop-shell.md", href: "/workspace" },
      },
      {
        gatewayOrigin: "http://127.0.0.1:18790",
        targetDocument: targetDocument as unknown as Document,
        targetWindow: targetWindow as unknown as Window,
      },
    );

    expect(historyCalls).toEqual(["http://localhost:1420/workspace"]);
    expect(focused).toEqual(["workspace:docs/desktop-shell.md"]);
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("workspace");
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
