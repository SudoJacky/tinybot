// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ProjectGroupStore, SessionSummary, WorkspaceRegistryStore } from "../services";
import { i18n } from "../i18n";
import { CHAT_SESSION_TABS_STORAGE_KEY } from "./sessionTabWorkspace";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  expectTurnSubmit,
  mockTurnSubmit,
  mountWorkbenchCss,
  nativeWorkspacePickerMocks,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
  it("starts in an uncreated conversation instead of restoring saved session tabs", async () => {
    const stores = createStores();
    window.localStorage.setItem(CHAT_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      activeSessionId: "s1",
      draftsBySession: {},
      openSessionIds: ["s1"],
    }));

    render(
      <ChatPage
        chatStore={stores.chatStore}
        sessionStore={stores.sessionStore}
        startInNewSession
      />,
    );

    await waitFor(() => expect(stores.sessionStore.list).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeTruthy();
    expect(stores.chatStore.load).not.toHaveBeenCalled();
  });

  it("allows drafting while sessions load but prevents sending", async () => {
    const user = userEvent.setup();
    const stores = createStores({ sessions: [] });
    let resolveSessions: ((sessions: SessionSummary[]) => void) | undefined;
    stores.sessionStore.list = vi.fn(() => new Promise<SessionSummary[]>((resolve) => {
      resolveSessions = resolve;
    }));

    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    await user.type(input, "Draft before startup completes");
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Loading conversations…");

    act(() => resolveSessions?.([]));
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(input.value).toBe("Draft before startup completes");
  });

  it("hides the plugin installation prompt while migration is still running", async () => {
    const migrationDirectory = "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1";
    const stores = createStores({
      sessions: [{
        id: "s1",
        title: "Migrate Skill or MCP",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "running",
        workingDirectory: migrationDirectory,
        pluginMigration: {
          jobId: "migration-1",
          workingDirectory: migrationDirectory,
          sourceDirectory: `${migrationDirectory}\\source`,
          outputDirectory: `${migrationDirectory}\\output`,
          detectedArtifacts: ["standalone Skill"],
          status: "pending",
        },
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 2, 0)}
        sessionStore={stores.sessionStore}
        toolsStore={{ installPluginMigration: vi.fn() }}
      />,
    );

    await waitFor(() => expect(stores.chatStore.load).toHaveBeenCalled());
    expect(screen.queryByLabelText("Plugin migration result")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install migrated plugin" })).toBeNull();
  });

  it("installs a completed plugin migration from the conversation and records the result", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        title: "Migrate Skill or MCP",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "idle",
        workingDirectory: "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1",
        pluginMigration: {
          jobId: "migration-1",
          workingDirectory: "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1",
          sourceDirectory: "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1\\source",
          outputDirectory: "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1\\output",
          detectedArtifacts: ["standalone Skill"],
          status: "pending",
        },
      }],
    });
    const markInstalled = vi.fn(async () => undefined);
    stores.sessionStore.markPluginMigrationInstalled = markInstalled;
    const installPluginMigration = vi.fn(async () => ({
      plugin: {
        name: "legacy-tools",
        builtIn: false,
        enabled: true,
        valid: true,
        installedAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        sourcePath: "migration:migration-1",
        installPath: "C:\\Users\\test\\.tinybot\\plugins\\cache\\legacy-tools",
        skills: [],
        mcpServers: [],
        diagnostics: [],
      },
    }));

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 2, 0)}
        sessionStore={stores.sessionStore}
        toolsStore={{ installPluginMigration }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Install migrated plugin" }));

    await screen.findByText("legacy-tools installed and enabled");
    expect(installPluginMigration).toHaveBeenCalledWith("migration-1");
    expect(markInstalled).toHaveBeenCalledWith("s1", "legacy-tools", true, undefined);
    expect(screen.queryByRole("button", { name: "Install migrated plugin" })).toBeNull();
  });

  it("collapses and expands the session sidebar without losing session access", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(within(sidebar).queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation tab" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));

    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand session sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New conversation tab" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Expand session sidebar" }));

    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("heading", { name: "Tinybot" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New conversation tab" })).toBeNull();
  });

  it("groups sessions by workspace and creates another session in that directory", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\py\\tinybot";
    mountWorkbenchCss();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          chatId: "chat-1",
          title: "Planning notes",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "idle",
          workingDirectory,
        },
        {
          id: "s2",
          chatId: "chat-2",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          status: "idle",
          workingDirectory: "d:/code/py/tinybot/",
        },
        {
          id: "s3",
          chatId: "chat-3",
          title: "General question",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 40, 0),
          status: "idle",
        },
      ],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    const workspace = within(sidebar).getByRole("group", { name: "Workspace tinybot" });
    const workspaceDetails = workspace.querySelector("details");
    const workspaceSummary = workspaceDetails?.querySelector("summary");
    const collapsedFolder = workspaceSummary?.querySelector(".react-session-workspace__folder-icon--collapsed");
    const expandedFolder = workspaceSummary?.querySelector(".react-session-workspace__folder-icon--expanded");
    expect(collapsedFolder).toBeTruthy();
    expect(expandedFolder).toBeTruthy();
    expect(getComputedStyle(collapsedFolder as Element).display).toBe("none");
    expect(getComputedStyle(expandedFolder as Element).display).not.toBe("none");
    expect(within(workspace).getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(within(workspace).getByRole("button", { name: "Knowledge review" })).toBeTruthy();
    expect(within(sidebar).getByRole("group", { name: "Workspace General chats" })).toBeTruthy();

    await user.click(workspaceSummary as HTMLElement);
    expect(workspaceDetails?.hasAttribute("open")).toBe(false);
    expect(getComputedStyle(collapsedFolder as Element).display).not.toBe("none");
    expect(getComputedStyle(expandedFolder as Element).display).toBe("none");

    await user.click(workspaceSummary as HTMLElement);
    await user.click(within(workspace).getByRole("button", { name: "New session in tinybot" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), {
      target: { value: "Continue in this workspace" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory }));
  });

  it("localizes the group for sessions without a working directory", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "General question",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 40, 0),
        status: "idle",
      }],
    });

    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    try {
      render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

      const sidebar = await screen.findByRole("complementary", { name: "会话" });
      expect(await within(sidebar).findByRole("group", { name: "工作区 常规会话" })).toBeTruthy();
    } finally {
      cleanup();
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("inherits the active workspace when creating a session from the global action", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\py\\tinybot";
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory,
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Continue here");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory });
  });

  it("discards an untouched local session draft when another session is selected", async () => {
    const user = userEvent.setup();
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));
    expect(screen.getByRole("tab", { name: "New chat" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Planning notes" }));

    expect(screen.queryByRole("tab", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Planning notes" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
  });

  it("keeps a non-empty local session draft when another session is selected", async () => {
    const user = userEvent.setup();
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Keep this draft");

    await user.click(screen.getByRole("button", { name: "Planning notes" }));
    const draftTab = screen.getByRole("tab", { name: "New chat" });
    expect(draftTab).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();

    await user.click(draftTab);
    expect((screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value)
      .toBe("Keep this draft");
  });

  it("materializes the startup draft before opening another local draft", async () => {
    const user = userEvent.setup();
    const stores = createStores();

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        startInNewSession
      />,
    );

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await user.type(input, "Keep the startup draft");
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));

    const draftTabs = screen.getAllByRole("tab", { name: "New chat" });
    expect(draftTabs).toHaveLength(2);
    expect(input.value).toBe("");
    await user.click(draftTabs[0]);
    expect(input.value).toBe("Keep the startup draft");
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
  });

  it("restores a non-empty local session draft after leaving and returning to Chat", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const view = render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Restore this draft");
    view.unmount();

    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} />);

    expect((await screen.findByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value)
      .toBe("Restore this draft");
    expect(screen.getByRole("tab", { name: "New chat" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
  });

  it("does not inherit an active coordinator when creating from the global action", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "coordinator",
        chatId: "chat-coordinator",
        title: "Coordinate group-1",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        projectCoordinator: true,
        projectGroupId: "group-1",
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Start independently");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(stores.sessionStore.create).toHaveBeenCalledWith({});
  });

  it("does not inherit a cleaned plugin migration directory when creating a session", async () => {
    const user = userEvent.setup();
    const migrationDirectory = "C:\\Users\\test\\.tinybot\\plugins\\migrations\\migration-1";
    const stores = createStores({
      sessions: [{
        id: "s1",
        title: "Migrate Skill or MCP",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory: migrationDirectory,
        pluginMigration: {
          jobId: "migration-1",
          workingDirectory: migrationDirectory,
          sourceDirectory: `${migrationDirectory}\\source`,
          outputDirectory: `${migrationDirectory}\\output`,
          detectedArtifacts: ["standalone Skill"],
          status: "installed",
          installedPluginName: "legacy-tools",
          installedPluginEnabled: true,
        },
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Start cleanly");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(stores.sessionStore.create).toHaveBeenCalledWith({});
  });

  it("shows a selected workspace as a local draft and creates it on first send", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\VirtualHome";
    const stores = createStores();
    nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockResolvedValueOnce(workingDirectory);
    vi.mocked(stores.sessionStore.create).mockResolvedValueOnce({
      id: "workspace-session",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      workingDirectory,
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Workspace and project actions" }));
    await user.click(within(sidebar).getByRole("menuitem", { name: "Add workspace folder" }));

    expect(await within(sidebar).findByRole("group", { name: "Workspace VirtualHome" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    expect(stores.chatStore.load).not.toHaveBeenCalledWith("workspace-session");

    await user.type(screen.getByRole("textbox", { name: /message/i }), "Inspect this workspace");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory });
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("workspace-session"));
  });

  it("keeps a newly registered workspace after its pristine draft is discarded", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\VirtualHome";
    const stores = createStores();
    const workspace = {
      addedAtMs: 1,
      exists: true,
      name: "VirtualHome",
      path: workingDirectory,
      updatedAtMs: 1,
    };
    let resolveWorkspaceList!: (workspaces: (typeof workspace)[]) => void;
    const workspaceRegistryStore: WorkspaceRegistryStore = {
      list: vi.fn(() => new Promise<(typeof workspace)[]>((resolve) => {
        resolveWorkspaceList = resolve;
      })),
      register: vi.fn(async () => workspace),
      rename: vi.fn(async (_path, name) => ({ ...workspace, name })),
      forget: vi.fn(async () => undefined),
    };
    nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockResolvedValueOnce(workingDirectory);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        workspaceRegistryStore={workspaceRegistryStore}
      />,
    );

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Workspace and project actions" }));
    await user.click(within(sidebar).getByRole("menuitem", { name: "Add workspace folder" }));
    expect(await within(sidebar).findByRole("group", { name: "Workspace VirtualHome" })).toBeTruthy();
    expect(workspaceRegistryStore.register).toHaveBeenCalledWith(workingDirectory);

    await act(async () => resolveWorkspaceList([]));

    await user.click(within(sidebar).getByRole("button", { name: "Planning notes" }));

    expect(await within(sidebar).findByRole("group", { name: "Workspace VirtualHome" })).toBeTruthy();
    expect(within(sidebar).getByRole("button", { name: "Manage VirtualHome" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
  });

  it("defers workspace creation failures until the first send and exposes them", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockResolvedValueOnce("Z:\\missing");
    vi.mocked(stores.sessionStore.create).mockRejectedValueOnce(
      new Error("failed to inspect working directory `Z:\\missing`"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Workspace and project actions" }));
    await user.click(within(sidebar).getByRole("menuitem", { name: "Add workspace folder" }));

    expect(nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect(stores.sessionStore.create).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await user.type(input, "Inspect this workspace");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory: "Z:\\missing" });
    expect((await within(sidebar).findByRole("alert")).textContent).toContain(
      "failed to inspect working directory `Z:\\missing`",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[session-workspaces] session.create.failed",
      expect.objectContaining({
        error: "failed to inspect working directory `Z:\\missing`",
        workingDirectory: "Z:\\missing",
      }),
    );
    expect(input.value).toBe("Inspect this workspace");
    consoleError.mockRestore();
  });

  it("creates an explicit multi-root project and starts its coordinator session", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Payments workspace",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory: "D:\\Services\\payments",
      }],
    });
    const projectGroupStore: ProjectGroupStore = {
      list: vi.fn(async () => []),
      save: vi.fn(async (input) => ({
        projectGroupId: "commerce",
        name: input.name,
        workspaceIds: input.workspaceIds,
      })),
      delete: vi.fn(async () => undefined),
    };
    const workspaceRegistryStore: WorkspaceRegistryStore = {
      list: vi.fn(async () => [{
        addedAtMs: 1,
        exists: true,
        name: "payments",
        path: "D:\\Services\\payments",
        updatedAtMs: 1,
      }]),
      register: vi.fn(async (path) => ({
        addedAtMs: 2,
        exists: true,
        name: "payments",
        path,
        updatedAtMs: 2,
      })),
      rename: vi.fn(),
      forget: vi.fn(),
    };
    nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockResolvedValueOnce("E:\\Services\\payments");

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        projectGroupStore={projectGroupStore}
        sessionStore={stores.sessionStore}
        workspaceRegistryStore={workspaceRegistryStore}
      />,
    );

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Workspace and project actions" }));
    await user.click(within(sidebar).getByRole("menuitem", { name: "Create project group" }));
    const dialog = await screen.findByRole("dialog", { name: "Create project group" });
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Commerce");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Choose another folder…" }));
    await user.click(within(dialog).getByRole("button", { name: "Save project" }));

    expect(projectGroupStore.save).toHaveBeenCalledWith({
      name: "Commerce",
      workspaceIds: ["D:\\Services\\payments", "E:\\Services\\payments"],
    });
    const project = await within(sidebar).findByRole("group", { name: "Project Commerce" });
    await user.click(within(project).getByRole("button", { name: "New coordination chat in Commerce" }));
    expect(stores.sessionStore.create).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: /message/i }), "Coordinate the project");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.sessionStore.create).toHaveBeenLastCalledWith({
      projectCoordinator: true,
      projectGroupId: "commerce",
      title: "Coordinate Commerce",
    });
  });

  it("creates a project workspace session in the clicked workspace while a coordinator is active", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\py\\tbtest";
    const stores = createStores({
      sessions: [
        {
          id: "coordinator",
          chatId: "chat-coordinator",
          title: "Coordinate group-1",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "idle",
          projectCoordinator: true,
          projectGroupId: "group-1",
        },
        {
          id: "workspace-session",
          chatId: "chat-workspace",
          title: "List workspace files",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          status: "idle",
          workingDirectory,
          projectGroupId: "group-1",
        },
      ],
    });
    vi.mocked(stores.sessionStore.create).mockImplementation(async (input) => ({
      id: "created-workspace-session",
      chatId: "chat-created-workspace",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "idle",
      workingDirectory: input?.workingDirectory,
      projectGroupId: input?.projectGroupId,
    }));
    const projectGroupStore: ProjectGroupStore = {
      list: vi.fn(async () => [{
        projectGroupId: "group-1",
        name: "group-1",
        workspaceIds: [workingDirectory],
      }]),
      save: vi.fn(),
      delete: vi.fn(),
    };

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        projectGroupStore={projectGroupStore}
        sessionStore={stores.sessionStore}
      />,
    );

    const sidebar = await screen.findByLabelText("Sessions");
    const project = await within(sidebar).findByRole("group", { name: "Project group-1" });
    await user.click(within(project).getByRole("button", { name: "New session in tbtest" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Work in tbtest");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.sessionStore.create).toHaveBeenLastCalledWith({
      workingDirectory,
      projectGroupId: "group-1",
    });
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("created-workspace-session"));
    const createdRow = within(project).getByRole("button", { name: "Work in tbtest" })
      .closest<HTMLElement>(".react-session-row");
    expect(createdRow?.dataset.active).toBe("true");
  });

  it("opens sidebar sessions as an accessible multi-session tab set", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          chatId: "chat-1",
          title: "Planning notes",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "idle",
        },
        {
          id: "s2",
          chatId: "chat-2",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          status: "running",
        },
      ],
    });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    const tablist = screen.getByRole("tablist", { name: "Open conversations" });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1);

    await user.click(within(sidebar).getByRole("button", { name: "Knowledge review" }));

    expect(within(tablist).getAllByRole("tab")).toHaveLength(2);
    expect(within(tablist).getByRole("tab", { name: "Knowledge review, running" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("s2"));
  });

  it("clears the active workspace child running indicator from its completed timeline", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession: SessionSummary = {
      id: "workspace-child",
      chatId: "workspace-child",
      title: "Inspect workspace",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running",
      workingDirectory: "D:\\Code\\workspace",
    };
    const stores = createStores({ sessions: [runningSession] });
    const runningTimeline = await stores.chatStore.load(runningSession.id);
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    const completedTimeline = structuredClone(runningTimeline);
    completedTimeline.turns[completedTimeline.turns.length - 1].status = "completed";
    stores.chatStore.load = vi.fn(async () => runningTimeline);
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage
      chatStore={stores.chatStore}
      now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
      sessionStore={stores.sessionStore}
    />);

    await screen.findByRole("tab", { name: "Inspect workspace, running" });
    await waitFor(() => expect(stores.chatStore.subscribe).toHaveBeenCalledWith(
      runningSession.id,
      expect.any(Function),
    ));
    act(() => subscribed?.({ type: "timeline.patch", timeline: completedTimeline }));

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Inspect workspace, running" })).toBeNull();
      expect(screen.getByRole("tab", { name: "Inspect workspace" })).toBeTruthy();
    });
  });

  it("preserves per-session drafts and closing a tab does not delete the session", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          chatId: "chat-1",
          title: "Planning notes",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "idle",
        },
        {
          id: "s2",
          chatId: "chat-2",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          status: "idle",
        },
      ],
    });
    const listSessions = stores.sessionStore.list;
    stores.sessionStore.list = vi.fn(async () => {
      const sessions = await listSessions();
      await new Promise((resolve) => window.setTimeout(resolve, 1));
      return sessions;
    });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    const tablist = screen.getByRole("tablist", { name: "Open conversations" });
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    await user.type(input, "draft for planning");
    await user.click(within(sidebar).getByRole("button", { name: "Knowledge review" }));
    await user.type(input, "draft for knowledge");

    await user.click(within(tablist).getByRole("tab", { name: "Planning notes" }));
    expect(input.value).toBe("draft for planning");
    await user.click(screen.getByRole("button", { name: "Close Planning notes tab" }));

    expect(stores.sessionStore.delete).not.toHaveBeenCalled();
    expect(within(tablist).queryByRole("tab", { name: "Planning notes" })).toBeNull();
    expect(input.value).toBe("draft for knowledge");
  });

  it("marks background completion unread without interrupting the active tab", async () => {
    const user = userEvent.setup();
    const listeners = new Map<string, (event: ChatEvent) => void>();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          chatId: "chat-1",
          title: "Planning notes",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "running",
        },
        {
          id: "s2",
          chatId: "chat-2",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          status: "idle",
        },
      ],
    });
    stores.chatStore.subscribe = vi.fn((sessionId, listener) => {
      listeners.set(sessionId, listener);
      return () => {
        if (listeners.get(sessionId) === listener) listeners.delete(sessionId);
      };
    });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Knowledge review" }));
    await waitFor(() => expect(listeners.has("s1")).toBe(true));

    act(() => listeners.get("s1")?.({ type: "agent.event", eventType: "agent.turn.completed" }));

    const backgroundTab = screen.getByRole("tab", { name: "Planning notes, running" }).closest(".react-session-tab");
    expect(backgroundTab?.getAttribute("data-unread")).toBe("true");
    expect(screen.getByRole("tab", { name: "Knowledge review" }).getAttribute("aria-selected")).toBe("true");
  });

  it("hides the session-list empty copy when the sidebar is collapsed", async () => {
    const stores = createStores();
    stores.sessionStore.list = vi.fn(async () => []);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionSidebarCollapsed
        sessionStore={stores.sessionStore}
      />,
    );

    const sidebar = await screen.findByLabelText("Sessions");
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByText("No sessions yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand session sidebar" })).toBeTruthy();
  });

  it("renders chat empty states without starting a session", async () => {
    const stores = createStores();
    stores.sessionStore.list = vi.fn(async () => []);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sessionEmptyState = await screen.findByText("No sessions yet.");
    const start = await screen.findByLabelText("Start a new chat");

    expect(sessionEmptyState.classList.contains("react-empty-state")).toBe(true);
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
    expect(screen.queryByLabelText("Select or create a session.")).toBeNull();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    expect(within(start).getByLabelText("Prompt suggestions")).toBeTruthy();
  });

  it("starts in a draft new chat when there are no sessions", async () => {
    const user = userEvent.setup();
    const stores = createStores({ sessions: [] });
    const created = {
      id: "s-new",
      chatId: "chat-new",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "idle" as const,
    };
    stores.sessionStore.create = vi.fn(async () => created);
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([created]);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Start a new chat");
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;

    expect(input.disabled).toBe(false);
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();

    await user.type(input, "Hello from an empty app");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expectTurnSubmit(stores.chatStore, "s-new", {
      reasoningEffort: "high",
      text: "Hello from an empty app",
    }));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps a draft-created session selected when the refreshed list has not caught up", async () => {
    const user = userEvent.setup();
    const stores = createStores({ sessions: [] });
    const created = {
      id: "s-new",
      chatId: "chat-new",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "running" as const,
    };
    stores.sessionStore.create = vi.fn(async () => created);
    stores.sessionStore.list = vi.fn(async () => []);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByLabelText("Start a new chat");
    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "Hello from an empty app");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s-new", {
      reasoningEffort: "high",
      text: "Hello from an empty app",
    }));
    expect(screen.getByRole("heading", { name: "Hello from an empty app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hello from an empty app" }).closest(".react-session-row")?.getAttribute("data-active")).toBe("true");
    expect(screen.queryByText("No sessions yet.")).toBeNull();
  });

  it("adds Animated List hooks to session rows", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const rows = await screen.findByLabelText("Session list rows");
    const sessionButton = screen.getByRole("button", { name: "Planning notes" });
    const row = sessionButton.closest(".react-session-row") as HTMLElement | null;

    expect(rows.getAttribute("data-motion")).toBe("animated-list");
    expect(row?.getAttribute("data-motion-role")).toBe("item");
    expect(row?.style.getPropertyValue("--react-session-row-index")).toBe("0");
    expect(row?.querySelector(".react-session-row__avatar")).toBeNull();
  });

  it("expands session search inline, filters the sidebar, and collapses from its close button", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.sessionStore.list = vi.fn(async () => [
      {
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle" as const,
      },
      {
        id: "s2",
        chatId: "chat-2",
        title: "ReactBits migration",
        updatedAtMs: Date.UTC(2026, 6, 4, 10, 56, 0),
        status: "idle" as const,
      },
    ]);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Search chats" }));

    const sidebar = screen.getByLabelText("Sessions");
    const input = within(sidebar).getByRole("textbox", { name: "Search chats" }) as HTMLInputElement;

    expect(input.placeholder).toBe("Search sessions…");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("dialog", { name: "Session search" })).toBeNull();

    await user.type(input, "react");

    expect(within(sidebar).queryByRole("button", { name: "Planning notes" })).toBeNull();
    expect(within(sidebar).getByRole("button", { name: "ReactBits migration" })).toBeTruthy();
    await user.click(within(sidebar).getByRole("button", { name: "Close session search" }));

    expect(within(sidebar).queryByRole("textbox", { name: "Search chats" })).toBeNull();
    expect(within(sidebar).getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(within(sidebar).getByRole("button", { name: "ReactBits migration" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(
      within(sidebar).getByRole("button", { name: "Search chats" }),
    ));
  });

  it("clears and collapses inline session search with Escape", async () => {
    const user = userEvent.setup();
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Search chats" }));
    const sidebar = screen.getByLabelText("Sessions");
    const input = within(sidebar).getByRole("textbox", { name: "Search chats" });
    await user.type(input, "no matching session");

    expect(within(sidebar).getByText("No matching sessions.")).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(within(sidebar).queryByRole("textbox", { name: "Search chats" })).toBeNull();
    expect(within(sidebar).queryByText("No matching sessions.")).toBeNull();
    expect(within(sidebar).getByRole("button", { name: "Planning notes" })).toBeTruthy();
  });

  it("uses a two-click delete confirmation in the session list", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const row = await screen.findByRole("button", { name: "Planning notes" });
    await user.hover(row);
    await user.click(screen.getByRole("button", { name: /delete Planning notes/i }));
    expect(screen.getByRole("button", { name: /confirm delete Planning notes/i })).toBeTruthy();
    expect(stores.sessionStore.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm delete Planning notes/i }));
    expect(stores.sessionStore.delete).toHaveBeenCalledWith("s1");
  });

  it("dissolves a confirmed deleted session before removing it from the list", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sessionButton = await screen.findByRole("button", { name: "Planning notes" });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const row = sessionButton.closest(".react-session-row") as HTMLElement | null;
    fireEvent.mouseEnter(sessionButton);
    fireEvent.click(screen.getByRole("button", { name: /delete Planning notes/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm delete Planning notes/i }));
    await act(async () => {
      await Promise.resolve();
    });
    const dissolveTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 180);
    expect(dissolveTimerIndex).toBeGreaterThanOrEqual(0);
    const dissolveTimer = setTimeoutSpy.mock.calls[dissolveTimerIndex]?.[0];
    window.clearTimeout(setTimeoutSpy.mock.results[dissolveTimerIndex]?.value);
    setTimeoutSpy.mockRestore();
    mountWorkbenchCss();

    expect(stores.sessionStore.delete).toHaveBeenCalledWith("s1");
    expect(row?.dataset.dissolving).toBe("true");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(getComputedStyle(row?.querySelector(".react-session-row__delete") as Element).position).toBe("absolute");
    expect(getComputedStyle(row as Element).opacity).toBe("0");
    expect(row?.querySelector(".react-session-row__particle")).toBeNull();

    await act(async () => {
      expect(dissolveTimer).toEqual(expect.any(Function));
      (dissolveTimer as () => void)();
    });
    expect(screen.queryByRole("button", { name: "Planning notes" })).toBeNull();
  }, 15_000);

  it("keeps a pending new session visible until chat creation returns a real session", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    const pendingSession = {
      id: "pending:1",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "running" as const,
    };
    const realSession = {
      id: "WebSocket:chat-2",
      chatId: "chat-2",
      title: "Summarize docs",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      status: "idle" as const,
    };
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingSession])
      .mockResolvedValueOnce([realSession]);
    stores.sessionStore.create = vi.fn(async () => pendingSession);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByText("No sessions yet.");
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeTruthy();

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize docs");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "pending:1", {
      reasoningEffort: "high",
      text: "Summarize docs",
    }));
    expect(screen.queryByRole("heading", { name: "No conversation selected" })).toBeNull();
    expect(screen.getByRole("button", { name: "Summarize docs" })).toBeTruthy();

    subscribed?.({ type: "chat.created" });

    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("WebSocket:chat-2"));
    expect(screen.getByRole("heading", { name: "Summarize docs" })).toBeTruthy();
  });

  it("keeps the optimistic first-prompt title across an early chat.created refresh", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    let resolveSend: (() => void) | undefined;
    const genericSession = {
      id: "s1",
      chatId: "chat-1",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "idle" as const,
    };
    const replacementSession = {
      ...genericSession,
      id: "s2",
      chatId: "chat-2",
    };
    const stores = createStores({ sessions: [genericSession] });
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([genericSession])
      .mockResolvedValue([replacementSession]);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    mockTurnSubmit(stores.chatStore, () => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    fireEvent.change(input, { target: { value: "Keep this optimistic title" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByRole("heading", { name: "Keep this optimistic title" })).toBeTruthy();
    await waitFor(() => expect(stores.sessionStore.rename).toHaveBeenCalledWith(
      "s1",
      "Keep this optimistic title",
    ));

    act(() => subscribed?.({ type: "chat.created" }));
    await waitFor(() => expect(stores.sessionStore.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("s2"));
    expect(screen.getByRole("heading", { name: "Keep this optimistic title" })).toBeTruthy();

    resolveSend?.();
  });

  it("runs conversation menu actions through stores and clipboard", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const prompt = vi.fn(() => "Renamed chat");
    Object.defineProperty(window, "prompt", {
      configurable: true,
      value: prompt,
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Open conversation menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin conversation" }));
    expect(stores.sessionStore.pin).toHaveBeenCalledWith("s1", true);

    await user.click(screen.getByRole("button", { name: "Open conversation menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(writeText).toHaveBeenCalledWith("s1");

    await user.click(screen.getByRole("button", { name: "Open conversation menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    expect(stores.chatStore.copyMarkdown).toHaveBeenCalledWith("s1");
    expect(writeText).toHaveBeenCalledWith("# Planning notes");

    await user.click(screen.getByRole("button", { name: "Open conversation menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename conversation" }));
    expect(prompt).toHaveBeenCalledWith("Rename conversation", "Planning notes");
    expect(stores.sessionStore.rename).toHaveBeenCalledWith("s1", "Renamed chat");

    await user.click(screen.getByRole("button", { name: "Open conversation menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive conversation" }));
    expect(stores.sessionStore.archive).toHaveBeenCalledWith("s1");
  });
});
