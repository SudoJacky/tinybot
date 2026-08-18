// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import type { ChatEvent, ChatStore, ProjectGroupStore, SessionStore, SessionSummary, SettingsStore } from "../services";
import type { DesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
import type { ReactChatMessage } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { createTinyOsAgentCancelCommand } from "../../app-core/chat/tinyOsCommand";
import type { TinyOsEffectiveCapabilities } from "../../app-core/chat/tinyOsCapabilities";
import { buildAgentDefaultsSettings } from "../../app-core/settings/agentDefaultsSettings";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import { i18n } from "../i18n";

const nativeFilePickerMocks = vi.hoisted(() => ({
  pickDesktopChatFiles: vi.fn(),
}));

const nativeWorkspacePickerMocks = vi.hoisted(() => ({
  pickDesktopWorkspaceDirectory: vi.fn(),
}));

vi.mock("../../app-core/native/desktopNativeFilePicker", () => ({
  pickDesktopChatFiles: nativeFilePickerMocks.pickDesktopChatFiles,
}));

vi.mock("../../app-core/native/desktopNativeWorkspacePicker", () => ({
  pickDesktopWorkspaceDirectory: nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory,
}));

afterEach(() => {
  cleanup();
  nativeFilePickerMocks.pickDesktopChatFiles.mockReset();
  nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockReset();
  window.localStorage.clear();
  document.head.querySelectorAll("[data-test-style='workbench']").forEach((element) => element.remove());
  vi.useRealTimers();
});

function mountWorkbenchCss(): void {
  const style = document.createElement("style");
  style.dataset.testStyle = "workbench";
  style.textContent = readWorkbenchCss();
  document.head.append(style);
}

function readWorkbenchCss(): string {
  return [
    "src/react-workbench/styles/workbench.css",
    "src/react-workbench/chat/ChatPage.css",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
}


function effectiveCapabilities(threadId: string, cancelAvailable = true): TinyOsEffectiveCapabilities {
  const unavailable = { available: false, reasonCode: "runtime_unsupported", reason: "Not supported." };
  const available = { available: true };
  return {
    schemaVersion: "tinybot.effective_capabilities.v2",
    threadId,
    capabilities: {
      agent: { cancel: cancelAvailable ? available : unavailable, retry: unavailable },
    },
  };
}

function createStores(options: { sessions?: SessionSummary[] } = {}): { chatStore: ChatStore; sessionStore: SessionStore } {
  const sessions = options.sessions ?? [
    {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "idle" as const,
    },
  ];
  const messages: ReactChatMessage[] = [
    {
      id: "u1",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
      text: "Can you help?",
      status: "complete",
    },
    {
      id: "a1",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
      text: "Yes.",
      status: "complete",
    },
    {
      id: "a2",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
      text: "I ran a tool.",
      status: "complete",
      toolCalls: [{ id: "tool-1", name: "shell", status: "complete", summary: "Done" }],
    },
  ];
  return {
    sessionStore: {
      list: vi.fn(async () => sessions),
      create: vi.fn(async () => ({
        id: "s2",
        chatId: "chat-2",
        title: "New session",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    },
    chatStore: {
      load: vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, messages)),
      loadTinyOsCapabilities: vi.fn(async (sessionId) => effectiveCapabilities(sessionId)),
      dispatch: vi.fn(async () => undefined),
      listAgentUiForms: vi.fn(async () => []),
      branchFromMessage: vi.fn(async () => sessions[0]),
      copyMarkdown: vi.fn(async () => "# Planning notes"),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

function turnSubmitCommands(chatStore: ChatStore): DesktopTurnSubmitCommand[] {
  return vi.mocked(chatStore.dispatch).mock.calls
    .map(([command]) => command)
    .filter((command): command is DesktopTurnSubmitCommand => command.kind === "turn.submit");
}

function expectTurnSubmit(chatStore: ChatStore, sessionId: string, input: unknown): void {
  expect(turnSubmitCommands(chatStore)).toContainEqual(expect.objectContaining({
    input,
    kind: "turn.submit",
    target: { sessionId },
  }));
}

async function mockLatestTurnStatus(
  chatStore: ChatStore,
  status: "pending" | "running" | "awaiting_user" | "completed" | "failed" | "interrupted",
): Promise<void> {
  const timeline = await chatStore.load("s1");
  timeline.turns[timeline.turns.length - 1].status = status;
  vi.mocked(chatStore.load).mockReset();
  vi.mocked(chatStore.load).mockResolvedValue(timeline);
}

function mockTurnSubmit(
  chatStore: ChatStore,
  implementation: (command: DesktopTurnSubmitCommand) => void | Promise<void>,
): void {
  const fallback = chatStore.dispatch;
  chatStore.dispatch = vi.fn(async (command) => {
    if (command.kind === "turn.submit") {
      await implementation(command);
      return;
    }
    await fallback(command);
  });
}


function failedPlanTimeline(sessionId = "s1") {
  const timeline = timelineFromReactMessages(sessionId, [{
    id: "u-failed-plan",
    role: "user" as const,
    createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
    text: "Inspect the project and report findings",
    status: "complete" as const,
  }]);
  const turn = timeline.turns[0];
  turn.status = "failed";
  turn.steps = [
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "tool-failed-plan",
      kind: "tool_call",
      sequence: 1,
      status: "failed",
      title: "workspace.read_file",
      toolCall: { id: "call-failed-plan", name: "workspace.read_file", resultPreview: "Stopped" },
    },
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "plan-failed",
      kind: "plan",
      plan: {
        completed: 1,
        steps: [
          { step: "Inspect inputs", status: "completed" },
          { step: "Read project files", status: "failed" },
          { step: "Report findings", status: "cancelled" },
        ],
        total: 3,
      },
      sequence: 2,
      status: "failed",
      title: "Plan 1/3",
    },
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      error: { code: "max_iterations", message: "Rust agent runtime reached max iterations before final response." },
      id: "error-failed-plan",
      kind: "error",
      sequence: 3,
      status: "failed",
      summary: "Rust agent runtime reached max iterations before final response.",
      title: "Error",
    },
  ];
  return timeline;
}

describe("ChatPage", () => {
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

  it("uses a denser font scale for the chat surface", async () => {
    mountWorkbenchCss();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const chat = await screen.findByLabelText("Chat");

    expect(getComputedStyle(chat).fontSize).toBe("13px");
  });

  it("keeps expanded execution timelines at max-content height inside the conversation grid", async () => {
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-layout",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect layout",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "commentary-layout",
      kind: "message",
      messagePhase: "commentary",
      modelCallId: "call-layout",
      sequence: 1,
      status: "completed",
      summary: "Inspecting layout.",
      title: "Progress update",
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    mountWorkbenchCss();
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    const executionContent = document.querySelector<HTMLElement>(".react-execution-timeline__content")!;
    expect(getComputedStyle(executionTimeline).height).toBe("max-content");
    expect(getComputedStyle(executionTimeline).borderTopWidth).toBe("0px");
    expect(getComputedStyle(executionTimeline).marginLeft).toBe("0px");
    expect(getComputedStyle(executionContent).paddingLeft).toBe("0px");
  });

  it("renders the React chat layout without legacy header actions or the retired TinyOS entry", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByText("4 min")).toBeTruthy();
    expect(screen.queryByText(/unix-ms/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /TinyOS/i })).toBeNull();
    expect(screen.queryByText(/Agent · rust/i)).toBeNull();
  });

  it("collapses and expands the session sidebar without losing session access", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));

    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand session sidebar" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Expand session sidebar" }));

    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("heading", { name: "Tinybot" })).toBeTruthy();
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
    const workspaceSummary = workspace.querySelector("summary");
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
    expect(workspace.hasAttribute("open")).toBe(false);
    expect(getComputedStyle(collapsedFolder as Element).display).not.toBe("none");
    expect(getComputedStyle(expandedFolder as Element).display).toBe("none");

    await user.click(workspaceSummary as HTMLElement);
    await user.click(within(workspace).getByRole("button", { name: "New session in tinybot" }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory });
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
      expect(within(sidebar).getByRole("group", { name: "工作区 常规会话" })).toBeTruthy();
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

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "New chat" }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory });
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

    const sidebar = await screen.findByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "New chat" }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({});
  });

  it("creates and opens the first session for a selected workspace folder", async () => {
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
    expect(stores.sessionStore.create).toHaveBeenCalledWith({ workingDirectory });
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("workspace-session"));
  });

  it("selects a workspace folder and exposes native creation failures", async () => {
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
    nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockResolvedValueOnce("E:\\Services\\payments");

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        projectGroupStore={projectGroupStore}
        sessionStore={stores.sessionStore}
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
    expect(stores.sessionStore.create).toHaveBeenLastCalledWith({
      projectCoordinator: true,
      projectGroupId: "commerce",
      title: "Coordinate Commerce",
    });
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
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sidebar = await screen.findByLabelText("Sessions");
    const tablist = screen.getByRole("tablist", { name: "Open conversations" });
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
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
      reasoningEffort: "medium",
      text: "Hello from an empty app",
    }));
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
      reasoningEffort: "medium",
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

  it("uses the active session background for hovered and focused session rows", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.react-session-row\[data-active="true"\],\s*\.react-session-row:hover,\s*\.react-session-row:focus-within\s*{\s*background:\s*var\(--color-cream-strong\);/s,
    );
  });

  it("opens session search, filters chats, and selects a matching session", async () => {
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

    const dialog = screen.getByRole("dialog", { name: "Chat search" });
    const input = within(dialog).getByRole("textbox", { name: "Search chats or run a command" }) as HTMLInputElement;

    expect(input.placeholder).toBe("Search chats or run a command");
    expect(within(dialog).getByRole("button", { name: /Planning notes/ })).toBeTruthy();

    await user.type(input, "react");

    expect(within(dialog).queryByRole("button", { name: /Planning notes/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /ReactBits migration/ }));

    expect(screen.queryByRole("dialog", { name: "Chat search" })).toBeNull();
    expect(screen.getByRole("heading", { name: "ReactBits migration" })).toBeTruthy();
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenLastCalledWith("s2"));
  });

  it("runs the new chat recommendation from session search", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Search chats" }));

    const dialog = screen.getByRole("dialog", { name: "Chat search" });
    await user.click(within(dialog).getByRole("button", { name: /New chat/ }));

    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Chat search" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
  });

  it("uses a raised start layout for an empty active session", async () => {
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const start = await screen.findByLabelText("Start a new chat");
    const composer = screen.getByRole("form", { name: "Message composer" });
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;

    expect(start.getAttribute("data-empty-session")).toBe("true");
    expect(screen.getByRole("heading", { name: "What do you want Tinybot to do?" })).toBeTruthy();
    expect(composer.classList.contains("react-composer--raised")).toBe(true);
    expect(input.placeholder).toBe("Enter a task, or paste/drop files");
    expect(screen.queryByLabelText("Select or create a session.")).toBeNull();
  });

  it("fills the composer from an empty-session suggestion without sending", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const start = await screen.findByLabelText("Start a new chat");
    const suggestion = within(start).getByRole("button", { name: "Plan a task and list the implementation steps" });
    await user.click(suggestion);

    expect((screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("Plan a task and list the implementation steps");
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("keeps the normal bottom composer layout when a session has messages", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByText("Can you help?");
    const composer = screen.getByRole("form", { name: "Message composer" });

    expect(screen.queryByLabelText("Start a new chat")).toBeNull();
    expect(composer.classList.contains("react-composer--raised")).toBe(false);
    expect(screen.getByRole("textbox", { name: /message/i }).getAttribute("placeholder")).toBe("Message Tinybot");
    expect(message).toBeTruthy();
  });

  it("mentions another conversation from the active workspace and sends its transcript as evidence", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          title: "Current implementation",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          status: "idle",
          workingDirectory: "D:\\Code\\py\\tinybot",
        },
        {
          id: "s2",
          title: "Architecture review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
          status: "idle",
          workingDirectory: "d:/code/py/tinybot/",
        },
        {
          id: "s3",
          title: "Other workspace",
          updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
          status: "idle",
          workingDirectory: "D:\\Code\\other",
        },
      ],
    });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Compare with @arch");

    const listbox = screen.getByRole("listbox", { name: "Workspace conversations" });
    expect(within(listbox).queryByRole("option", { name: /Current implementation/ })).toBeNull();
    expect(within(listbox).queryByRole("option", { name: /Other workspace/ })).toBeNull();
    await user.click(within(listbox).getByRole("option", { name: /Architecture review/ }));

    expect(within(screen.getByLabelText("Composer attachments")).getByText("Architecture review")).toBeTruthy();
    await user.type(input, "for regressions");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(stores.chatStore.copyMarkdown).toHaveBeenCalledWith("s2"));
    expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      references: [{
        detail: "Conversation snapshot",
        kind: "reference",
        revision: String(Date.UTC(2026, 6, 4, 11, 59, 0)),
        scope: "s2",
        sourceText: "# Planning notes",
        title: "Architecture review",
        type: "tinyos.thread",
      }],
      text: "Compare with for regressions",
    });
  });

  it("expands a filtered slash command without sending it immediately", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await user.clear(input);
    await user.type(input, "/rev");

    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getByRole("option", { name: /\/review Review changes/ })).toBeTruthy();
    expect(within(commands).queryByRole("option", { name: /\/plan/ })).toBeNull();

    await user.keyboard("{Enter}");

    expect(input.value).toBe("Review the current workspace changes. Prioritize concrete defects, regression risks, and missing tests.");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("runs /compact as a control command without creating a user message", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const initialTimeline = await stores.chatStore.load("s1");
    const compactingTimeline = structuredClone(initialTimeline);
    compactingTimeline.turns.push({
      id: "turn-manual-compact",
      sessionKey: "s1",
      userMessageId: "user:turn-manual-compact",
      userMessage: {
        id: "user:turn-manual-compact",
        role: "user",
        text: "",
        timestamp: "2026-07-04T12:00:00.000Z",
      },
      status: "running",
      steps: [{
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        compaction: { droppedItemCount: 3, estimatedTokensAfter: 4200, estimatedTokensBefore: 12000 },
        id: "context-manual-compact",
        kind: "compaction",
        sequence: 1,
        status: "completed",
        title: "Context compacted",
      }],
      startedAt: "2026-07-04T12:00:00.000Z",
      updatedAt: "2026-07-04T12:00:00.000Z",
    });
    compactingTimeline.turnRevisions["turn-manual-compact"] = 1;
    const completedTimeline = structuredClone(compactingTimeline);
    completedTimeline.turns[completedTimeline.turns.length - 1].status = "completed";
    completedTimeline.turns[completedTimeline.turns.length - 1].completedAt = "2026-07-04T12:00:01.000Z";
    completedTimeline.turnRevisions["turn-manual-compact"] = 2;
    let timelineToLoad = initialTimeline;
    stores.chatStore.load = vi.fn(async () => structuredClone(timelineToLoad));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    let resolveCompact!: () => void;
    stores.chatStore.dispatch = vi.fn(() => new Promise<void>((resolve) => {
      resolveCompact = resolve;
    }));
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await user.type(input, "/comp");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "context.compact",
      source: { control: "slash-compact", surface: "chat" },
      target: { sessionId: "s1" },
    })));
    expect(input.value).toBe("");
    expect(screen.getByRole("status").textContent).toContain("Compacting context");
    expect(screen.queryByText("/compact")).toBeNull();
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);

    act(() => subscribed?.({ type: "timeline.patch", timeline: compactingTimeline }));
    expect(await screen.findByRole("button", { name: "Stop generation" })).toBeTruthy();
    timelineToLoad = completedTimeline;
    act(() => resolveCompact());
    await waitFor(() => expect(screen.queryByText("Compacting context")).toBeNull());
    await waitFor(() => expect(stores.chatStore.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop generation" })).toBeNull());
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("surfaces /compact failures and removes the running state", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stores.chatStore.dispatch = vi.fn(async () => {
      throw new Error("Compaction failed at the runtime boundary");
    });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "/comp");
    await user.keyboard("{Enter}");

    expect((await screen.findByRole("alert")).textContent).toContain("Compaction failed at the runtime boundary");
    expect(screen.queryByText("Compacting context")).toBeNull();
    expect(consoleError).toHaveBeenCalledWith("[chat] context.compact.failed", {
      error: "Compaction failed at the runtime boundary",
      sessionId: "s1",
    });
    consoleError.mockRestore();
  });

  it("preserves manual scroll position and offers a back-to-latest action", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const conversation = await screen.findByLabelText("Conversation");
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 200 },
    });
    fireEvent.scroll(conversation);

    const back = screen.getByRole("button", { name: "Back to latest" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(conversation.lastElementChild!, "scrollIntoView", { configurable: true, value: scrollIntoView });
    await user.click(back);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.queryByRole("button", { name: "Back to latest" })).toBeNull();
  });

  it("renders context window usage as an icon-only composer indicator", async () => {
    const stores = createStores();
    const usageMessages: ReactChatMessage[] = [
      {
        id: "u1",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
        text: "Can you help?",
        status: "complete",
      },
      {
        id: "a1",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "Yes.",
        status: "complete",
        usage: {
          contextWindowRemainingTokens: 168000,
          contextWindowStrategy: "compact",
          contextWindowTokens: 256000,
          contextWindowUsedTokens: 88000,
          percent: 34.4,
        },
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, usageMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 34% used, 66% left");
    expect(indicator.classList.contains("claude-ai-input__context-usage")).toBe(true);
    expect(indicator.getAttribute("data-state")).toBe("normal");
    expect(indicator.textContent).toContain("88k / 256k tokens used");
    expect(indicator.textContent).toContain("Strategy: compact");
  });

  it("renders a zero context window indicator before token usage arrives", async () => {
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 0% used, 100% left");
    expect(indicator.classList.contains("claude-ai-input__context-usage")).toBe(true);
    expect(indicator.getAttribute("data-state")).toBe("normal");
    expect(indicator.textContent).toContain("0 tokens used");
  });

  it("restores the post-compaction context usage when a session is loaded", async () => {
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [
      {
        id: "u-context-before",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
        text: "Use the existing context",
        status: "complete",
      },
      {
        id: "a-context-before",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "Context is near the limit.",
        status: "complete",
        usage: {
          contextWindowRemainingTokens: 116000,
          contextWindowStrategy: "compact",
          contextWindowTokens: 128000,
          contextWindowUsedTokens: 12000,
          percent: 9.375,
        },
      },
    ]);
    canonical.turns.push({
      completedAt: "2026-07-04T11:59:00.000Z",
      id: "turn-context-compacted",
      sessionKey: "s1",
      startedAt: "2026-07-04T11:59:00.000Z",
      status: "completed",
      steps: [{
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        compaction: {
          droppedItemCount: 12,
          estimatedTokensAfter: 4200,
          estimatedTokensBefore: 12000,
        },
        id: "context-compaction-1",
        kind: "compaction",
        sequence: 1,
        status: "completed",
        title: "Context compacted",
      }],
      updatedAt: "2026-07-04T11:59:00.000Z",
      userMessage: {
        id: "user:turn-context-compacted",
        role: "user",
        text: "",
        timestamp: "2026-07-04T11:59:00.000Z",
      },
      userMessageId: "user:turn-context-compacted",
    });
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 3% used, 97% left");
    expect(indicator.textContent).toContain("4.2k / 128k tokens used");
    expect(indicator.textContent).toContain("Strategy: compact");
  });

  it("restores compacted token usage when no historical usage event was persisted", async () => {
    const stores = createStores();
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadAgentDefaultsSettings: vi.fn(async () => buildAgentDefaultsSettings({
        agents: {
          defaults: {
            contextWindowStrategy: "compact",
            contextWindowTokens: 128000,
          },
        },
      })),
    };
    const canonical = timelineFromReactMessages("s1", []);
    canonical.turns.push({
      completedAt: "2026-07-04T11:59:00.000Z",
      id: "turn-context-compacted-only",
      sessionKey: "s1",
      startedAt: "2026-07-04T11:59:00.000Z",
      status: "completed",
      steps: [{
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        compaction: {
          droppedItemCount: 0,
          estimatedTokensAfter: 32066,
          estimatedTokensBefore: 48428,
        },
        id: "context-compaction-only",
        kind: "compaction",
        sequence: 1,
        status: "completed",
        title: "Context compacted",
      }],
      updatedAt: "2026-07-04T11:59:00.000Z",
      userMessage: {
        id: "user:turn-context-compacted-only",
        role: "user",
        text: "",
        timestamp: "2026-07-04T11:59:00.000Z",
      },
      userMessageId: "user:turn-context-compacted-only",
    });
    stores.chatStore.load = vi.fn(async () => canonical);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    const indicator = await screen.findByLabelText("Context window 25% used, 75% left");
    expect(indicator.textContent).toContain("32.1k / 128k tokens used");
    expect(indicator.textContent).toContain("Strategy: compact");
  });

  it("prefers provider usage emitted after compaction in the same turn", async () => {
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [
      {
        id: "u-context-current",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
        text: "Continue after compacting",
        status: "complete",
      },
      {
        id: "a-context-current",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "Continued.",
        status: "complete",
        usage: {
          contextWindowRemainingTokens: 123000,
          contextWindowStrategy: "compact",
          contextWindowTokens: 128000,
          contextWindowUsedTokens: 5000,
          percent: 3.90625,
        },
      },
    ]);
    canonical.turns[0]?.steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      compaction: {
        droppedItemCount: 12,
        estimatedTokensAfter: 4200,
        estimatedTokensBefore: 12000,
      },
      id: "context-compaction-current",
      kind: "compaction",
      sequence: 1,
      status: "completed",
      title: "Context compacted",
    });
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 4% used, 96% left");
    expect(indicator.textContent).toContain("5k / 128k tokens used");
  });

  it("updates context usage from a canonical timeline subscription without reloading history", async () => {
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByText("Yes.")).toBeTruthy();
    expect(screen.getByLabelText("Context window 0% used, 100% left")).toBeTruthy();

    act(() => {
      listener?.({
        type: "timeline.patch",
        timeline: timelineFromReactMessages("s1", [
          {
            id: "u1",
            role: "user",
            createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
            text: "Can you help?",
            status: "complete",
          },
          {
          id: "a1",
          role: "assistant",
          createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
          text: "Yes.",
          status: "complete",
          usage: {
            contextWindowRemainingTokens: 127893,
            contextWindowTokens: 128000,
            contextWindowUsedTokens: 107,
            percent: 0.08359375,
            promptTokens: 10,
            totalTokens: 107,
          },
          },
        ]),
      });
    });

    const indicator = await screen.findByLabelText("Context window 0% used, 100% left");
    expect(indicator.textContent).toContain("107 / 128k tokens used");

    act(() => {
      listener?.({ type: "agent.event", eventType: "agent.turn.completed" });
    });

    expect(stores.chatStore.load).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Context window 0% used, 100% left").textContent).toContain("107 / 128k tokens used");
  });

  it("keeps empty-session suggestions stable while the user is deciding", async () => {
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await act(async () => {
      await Promise.resolve();
    });
    const start = screen.getByLabelText("Start a new chat");
    expect(within(start).getByRole("heading", { name: "What do you want Tinybot to do?" })).toBeTruthy();
    expect(within(start).getAllByRole("button")).toHaveLength(4);
    expect(within(start).getByRole("button", { name: "Check the approach for anything that may have been missed" })).toBeTruthy();
    const nextSuggestions = within(start).getByLabelText("Prompt suggestions");
    expect(nextSuggestions.textContent).toContain("Plan a task and list the implementation steps");
    expect(nextSuggestions.textContent).toContain("Check the approach for anything that may have been missed");
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

  it("shows branch on a completed tool-backed final answer but not on user or commentary messages", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u1");
    expect(within(userMessage).queryByRole("button", { name: /branch from here/i })).toBeNull();

    expect(within(screen.getByTestId("message-a1")).queryByRole("button", { name: /branch from here/i })).toBeNull();
    expect(within(screen.getByTestId("message-a2")).getByRole("button", { name: /branch from here/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Agent steps, 1 step/i }));
    expect(screen.getByRole("button", { name: /open details for shell/i })).toBeTruthy();
  });

  it("hides copy and branch actions for reasoning-only assistant messages", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const reasoningOnlyMessages: ReactChatMessage[] = [
      {
        id: "a-thinking",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "",
        reasoningText: "Checking the current workspace before answering.",
        status: "complete",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, reasoningOnlyMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-thinking");
    const reasoning = within(message).getByLabelText("Reasoning");
    const reasoningToggle = within(reasoning).getByRole("button", { name: "Reasoning" });
    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByText("Checking the current workspace before answering.")).toBeNull();

    await user.click(reasoningToggle);

    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(reasoning).getByText("Checking the current workspace before answering.")).toBeTruthy();

    await user.click(reasoningToggle);

    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByText("Checking the current workspace before answering.")).toBeNull();
    expect(within(message).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(message).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(message.querySelector(".react-message__actions")).toBeNull();
  });

  it("expands live thinking and collapses it when the message completes", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    const liveMessage: ReactChatMessage = {
      id: "a-live-thinking",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "",
      reasoningText: "Inspecting the workspace.",
      status: "streaming",
    };
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [liveMessage]));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-live-thinking");
    const reasoning = within(message).getByLabelText("Reasoning");
    const reasoningToggle = within(reasoning).getByRole("button", { name: "Thinking" });
    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(reasoning).getByText("Inspecting the workspace.")).toBeTruthy();

    act(() => {
      subscribed?.({
        type: "timeline.patch",
        timeline: timelineFromReactMessages("s1", [{ ...liveMessage, status: "complete" }]),
      });
    });

    await waitFor(() => expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false"));
    expect(within(reasoning).queryByText("Inspecting the workspace.")).toBeNull();
  });

  it("hides assistant copy and branch actions until the turn completes", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const midTurnMessages: ReactChatMessage[] = [
      {
        id: "a-mid-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Partial body that arrived before the turn completed.",
        status: "complete",
        turnStatus: "running",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, midTurnMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-mid-turn");
    expect(within(message).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(message).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(message.querySelector(".react-message__actions")).toBeNull();
  });

  it("keeps actions on completed turn messages while a later turn is running", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const turnScopedMessages: ReactChatMessage[] = [
      {
        id: "a-completed-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Final answer from the previous turn.",
        status: "complete",
        turnId: "turn-1",
        turnStatus: "completed",
      },
      {
        id: "a-running-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Current turn body before the turn is done.",
        status: "complete",
        turnId: "turn-2",
        turnStatus: "running",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, turnScopedMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const completedMessage = await screen.findByTestId("message-a-completed-turn");
    expect(within(completedMessage).getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(within(completedMessage).getByRole("button", { name: "Branch from here" })).toBeTruthy();

    const runningMessage = await screen.findByTestId("message-a-running-turn");
    expect(within(runningMessage).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(runningMessage).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(runningMessage.querySelector(".react-message__actions")).toBeNull();
  });

  it("renders tool activity as collapsible agent steps", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByTestId("message-a2");
    const stepsToggle = screen.getByRole("button", { name: /Agent steps, 1 step/i });
    expect(stepsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Agent steps" })).toBeNull();

    await user.click(stepsToggle);

    expect(stepsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Agent steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details for shell" })).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("marks the current running agent step in the stepper", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const runningMessages: ReactChatMessage[] = [
      {
        id: "a-running",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Working through the task.",
        status: "complete",
        toolCalls: [
          { id: "tool-running", name: "workspace.read_file", status: "running", summary: "Reading current files" },
          { id: "tool-queued", name: "workspace.search", status: "queued", summary: "Waiting its turn" },
          { id: "tool-complete", name: "shell", status: "complete", summary: "Finished" },
        ],
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, runningMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByTestId("message-a-running");
    await user.click(screen.getByRole("button", { name: /Agent steps, 3 steps/i }));
    const stepper = document.querySelector(".react-agent-steps");
    const currentStep = document.querySelector(".react-agent-step-item[aria-current='step']") as HTMLElement | null;

    expect(stepper?.getAttribute("data-stepper")).toBe("true");
    expect(currentStep?.getAttribute("data-status")).toBe("active");
    expect(currentStep?.getAttribute("data-step-index")).toBe("0");
    expect(currentStep?.getAttribute("data-step-count")).toBe("3");
    expect(currentStep?.querySelector(".react-agent-step__status")?.textContent).toBe("In progress");
  });

  it("opens tool details in an animated right drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for shell" }));

    const drawer = screen.getByLabelText("Details drawer");
    expect(drawer.getAttribute("data-motion")).toBe("fade-content");
    expect(drawer.getAttribute("data-state")).toBe("open");
    expect(drawer.firstElementChild?.classList.contains("react-right-drawer__header")).toBe(true);
    expect(drawer.textContent).toContain("Done");
  });

  it("shows canonical tool arguments and result in the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const detailedMessages: ReactChatMessage[] = [{
      id: "a-tool-details",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "I checked the workspace.",
      status: "complete",
      toolCalls: [{
        argsText: "{\"path\":\"src/main.ts\"}",
        childTurnId: "child-turn-1",
        delegateId: "delegate-1",
        delegateTask: "Review implementation",
        delegateTitle: "Code reviewer",
        delegateType: "review",
        finalOutput: "Reviewed implementation.",
        id: "tool-1",
        name: "workspace.read_file",
        parentTurnId: "parent-turn-1",
        responseText: "file contents",
        sessionKey: "websocket:chat-1",
        status: "completed",
        summary: "Read src/main.ts",
        traceRef: "trace-1",
      } as NonNullable<ReactChatMessage["toolCalls"]>[number]],
    }];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, detailedMessages));
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for workspace.read_file" }));

    const drawer = screen.getByLabelText("Details drawer");
    expect(within(drawer).getByText("Arguments")).toBeTruthy();
    expect(drawer.textContent).toContain("{\"path\":\"src/main.ts\"}");
    expect(within(drawer).getByText("Response")).toBeTruthy();
    expect(drawer.textContent).toContain("file contents");
  });

  it("submits active agent-ui forms from the chat page", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      description: "Collect itinerary constraints before planning.",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: { chat_id: "chat-1", turn_id: "turn-1", session_id: "s1" },
      fields: [
        { name: "destination", type: "text", label: "Destination", required: true },
        { name: "nights", type: "number", label: "Nights", required: false, min: 1, max: 30 },
      ],
      values: { destination: "Shanghai", nights: 3 },
      errors: { destination: "Required" },
      status: "pending",
      chat_id: "chat-1",
    };
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].id = "turn-1";
    canonical.turns[0].status = "awaiting_user";
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: {
        errors: { destination: "Required" },
        fieldIds: ["destination", "nights"],
        formId: "travel-preferences-1",
      },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "blocked",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).listAgentUiForms = vi.fn(async () => [form]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const card = await screen.findByRole("form", { name: "Travel preferences" });
    expect(card.textContent).toContain("Collect itinerary constraints before planning.");
    expect(screen.getAllByText("Travel preferences")).toHaveLength(1);
    expect(within(card).getByRole("alert").textContent).toBe("Required");
    expect(within(card).getByLabelText("Destination").getAttribute("aria-invalid")).toBe("true");

    const destination = within(card).getByLabelText("Destination") as HTMLInputElement;
    const nights = within(card).getByLabelText("Nights") as HTMLInputElement;
    await user.clear(destination);
    await user.type(destination, "Singapore");
    await user.clear(nights);
    await user.type(nights, "4");
    expect(destination.value).toBe("Singapore");
    expect(nights.value).toBe("4");
    await user.click(within(card).getByRole("button", { name: "Save preferences" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      form: {
        formId: "travel-preferences-1",
        values: { destination: "Singapore", nights: 4 },
      },
      kind: "form.submit",
      source: { control: "chat-form", surface: "chat" },
      target: expect.objectContaining({ turnId: "turn-1", sessionId: "s1" }),
    }));
    expect(within(card).getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(true);
  });

  it("cancels active agent-ui forms through TinyOS command dispatch", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: { chat_id: "chat-1", turn_id: "turn-1", session_id: "s1" },
      fields: [{ name: "destination", type: "text", label: "Destination", required: true }],
      values: { destination: "Shanghai" },
      status: "pending",
      chat_id: "chat-1",
    };
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form-cancel",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].id = "turn-1";
    canonical.turns[0].status = "awaiting_user";
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: { fieldIds: ["destination"], formId: "travel-preferences-1" },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "blocked",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).listAgentUiForms = vi.fn(async () => [form]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const card = await screen.findByRole("form", { name: "Travel preferences" });
    await user.click(within(card).getByRole("button", { name: "Skip" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      form: { formId: "travel-preferences-1" },
      kind: "form.cancel",
      source: { control: "chat-form", surface: "chat" },
      target: expect.objectContaining({ turnId: "turn-1", sessionId: "s1" }),
    }));
    expect(within(card).getByRole("button", { name: "Skip" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders a resolved canonical form as a read-only submission summary", async () => {
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form-summary",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: {
        action: "submit",
        fieldIds: ["destination"],
        formId: "travel-preferences-1",
        values: { destination: "Singapore" },
      },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "completed",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const summary = await screen.findByRole("region", { name: "Travel preferences" });
    expect(summary.textContent).toContain("Submitted");
    expect(summary.textContent).toContain("destination");
    expect(summary.textContent).toContain("Singapore");
    expect(screen.queryByRole("form", { name: "Travel preferences" })).toBeNull();
  });

  it("opens the selected canonical subagent trace in the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-subagent",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect the repository",
      status: "complete",
    }]);
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      delegate: {
        id: "delegate-42",
        latestActivity: "Reading source files",
        status: "running",
        title: "Research agent",
        traceRef: "trace-delegate-42",
        type: "subagent",
      },
      id: "delegate-42",
      kind: "delegate",
      sequence: 1,
      status: "running",
      title: "Research agent",
    });
    const loadDelegateTrace = vi.fn(async () => ({
      trace: {
        delegateId: "delegate-42",
        status: "running",
        events: [{
          event_id: "trace-step-1",
          event_type: "child.tool.completed",
          created_at: "2026-07-04T12:01:01Z",
          payload: { status: "completed", title: "Inspect repository" },
        }],
      },
    }));
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).loadDelegateTrace = loadDelegateTrace;

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Open details for Research agent" }));
    expect(loadDelegateTrace).toHaveBeenCalledWith({
      delegateId: "delegate-42",
      sessionKey: "s1",
      traceRef: "trace-delegate-42",
    });
    const drawer = await screen.findByLabelText("Details drawer");
    await waitFor(() => expect(drawer.textContent).toContain("Inspect repository"));
    expect(drawer.textContent).toContain("delegate-42");
  });

  it("renders canonical plan progress and expandable compaction token details", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-plan",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Implement the timeline",
      status: "complete",
    }]);
    canonical.turns[0].steps.push(
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "plan-1",
        kind: "plan",
        plan: {
          completed: 1,
          currentStep: "Render progress",
          explanation: "Implementation order updated",
          steps: [
            { step: "Inspect model", status: "completed" },
            { step: "Render progress", status: "in_progress" },
            { step: "Run tests", status: "pending" },
          ],
          total: 3,
        },
        sequence: 1,
        status: "running",
        summary: "Canonical timeline rollout",
        title: "Plan 1/3",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        compaction: { droppedItemCount: 12, estimatedTokensAfter: 4200, estimatedTokensBefore: 12000 },
        id: "compaction-1",
        kind: "compaction",
        sequence: 2,
        status: "completed",
        summary: "compact",
        title: "Context compacted",
      },
    );
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const progress = await screen.findByRole("progressbar", { name: "Plan 1/3" });
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("3");
    expect(screen.getByText("Implementation order updated")).toBeTruthy();
    expect(screen.getByText("Inspect model").closest("li")?.getAttribute("data-status")).toBe("completed");
    expect(screen.getByText("Render progress")).toBeTruthy();
    expect(screen.getByText("Run tests").closest("li")?.getAttribute("data-status")).toBe("pending");
    await user.click(screen.getByText("Context compacted"));
    const compaction = screen.getByText("Before: 12,000 tokens").closest("details");
    expect(compaction?.textContent).toContain("After: 4,200 tokens");
    expect(compaction?.textContent).toContain("Dropped items: 12");
  });

  it("coalesces multiple running timeline patches into one animation-frame commit", async () => {
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    let frame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 7;
    });
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });
    const streamingTimeline = (text: string) => timelineFromReactMessages("s1", [{
      id: "u-stream-frame",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "Stream",
      status: "complete" as const,
    }, {
      id: "a-stream-frame",
      role: "assistant" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 1),
      text,
      status: "streaming" as const,
      turnStatus: "running" as const,
    }]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);
    expect(await screen.findByText("Yes.")).toBeTruthy();

    act(() => {
      listener?.({ type: "timeline.patch", timeline: streamingTimeline("A") });
      listener?.({ type: "timeline.patch", timeline: streamingTimeline("AB") });
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("AB")).toBeNull();
    act(() => frame?.(0));
    expect(await screen.findByText("AB")).toBeTruthy();
    requestFrame.mockRestore();
  });

  it("renders Plan first, collapses execution details, and exposes failure recovery", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const plan = await screen.findByRole("region", { name: "Execution plan" });
    const planToggle = within(plan).getByRole("button", { name: /Execution plan/ });
    const details = screen.getByRole("button", { name: /Agent steps, 1 step/i });
    const error = screen.getByRole("alert", { name: "Task execution failed" });
    expect(plan.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(error));
    expect(planToggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(planToggle);
    expect(planToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(planToggle);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(error.textContent).toContain("Execution reached the iteration limit");
    expect(error.textContent).toContain("Read project files");
    expect(error.textContent).toContain("1 steps completed");
    expect(within(error).getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(within(error).getByRole("button", { name: "Retry current step" })).toBeTruthy();
    expect(within(error).getByRole("button", { name: "Start over" })).toBeTruthy();

    await user.click(within(error).getByRole("button", { name: "View details" }));
    expect(screen.getByLabelText("Details drawer").textContent).toContain("max_iterations");
  });

  it("renders canonical execution items chronologically and restores completed turns folded", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-interleaved",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect and verify",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.status = "completed";
    turn.completedAt = new Date(Date.UTC(2026, 6, 4, 12, 1, 8)).toISOString();
    turn.steps = [
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "reasoning-0",
        kind: "reasoning",
        modelCallId: "call-0",
        sequence: 1,
        status: "completed",
        summary: "Inspect the first file.",
        title: "Thinking complete",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-0",
        kind: "message",
        messageId: "commentary-0",
        messagePhase: "commentary",
        modelCallId: "call-0",
        sequence: 2,
        status: "completed",
        summary: "I found the first file.",
        title: "Progress update",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "tool-1",
        kind: "tool_call",
        sequence: 3,
        status: "completed",
        title: "workspace.read_file",
        toolCall: { id: "tool-1", name: "workspace.read_file", resultPreview: "Loaded" },
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-1",
        kind: "message",
        messageId: "commentary-1",
        messagePhase: "commentary",
        modelCallId: "call-1",
        sequence: 4,
        status: "completed",
        summary: "Now I will verify it.",
        title: "Progress update",
      },
    ];
    turn.executionItems = turn.steps;
    turn.finalAnswer = {
      id: "final-1",
      role: "assistant",
      text: "Verification passed.",
      timestamp: turn.completedAt,
    };
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed Completed · 4 actions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Verification passed.")).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const orderedItems = document.querySelectorAll(".react-execution-timeline__item");
    expect([...orderedItems].map((item) => item.getAttribute("data-kind"))).toEqual([
      "reasoning",
      "message",
      "tool_call",
      "message",
    ]);
    const toolItem = [...orderedItems].find((item) => item.getAttribute("data-kind") === "tool_call")!;
    expect(toolItem.querySelector(".react-agent-steps__header")).toBeNull();
    expect(toolItem.querySelector(".react-tool-activity")).not.toBeNull();
    expect(screen.getByText("I found the first file.")).toBeTruthy();
    expect(screen.getByText("Now I will verify it.")).toBeTruthy();
  });

  it("renders apply_patch tool results as an inline file diff", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-patch-preview",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Update the parser",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "patch-1",
      kind: "tool_call",
      sequence: 1,
      status: "completed",
      title: "apply_patch",
      toolCall: {
        id: "patch-1",
        name: "apply_patch",
        resultJson: {
          result: {
            changed_files: [{
              path: "src/parser.rs",
              operation: "update",
              hunks: [{ index: 1, removed_lines: 1, added_lines: 1 }],
              delta: [{
                old_start: 44,
                new_start: 44,
                old_lines: ["let marker = line.trim();"],
                new_lines: ["let marker = line.trim_end();"],
              }],
              delta_truncated: false,
            }],
          },
        },
      },
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("region", { name: "Changes from apply_patch" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Diff for src/parser.rs" })).toBeTruthy();
    expect(screen.getByText("let marker = line.trim();")).toBeTruthy();
    expect(screen.getByText("let marker = line.trim_end();")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open details for Edited parser.rs" }));
    expect(screen.getByLabelText("Details drawer").textContent).toContain("apply_patch");
  });

  it("auto-folds untouched execution on final answer and preserves explicit user-open intent", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    const timelineFor = (completed: boolean, totalTokens?: number) => {
      const timeline = timelineFromReactMessages("s1", [{
        id: "u-live-timeline",
        role: "user" as const,
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Inspect live",
        status: "complete" as const,
      }]);
      const turn = timeline.turns[0];
      turn.status = completed ? "completed" : "running";
      turn.steps = [{
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-live",
        kind: "message",
        messageId: "commentary-live",
        messagePhase: "commentary",
        modelCallId: "call-live",
        sequence: 1,
        status: "completed",
        summary: "Inspecting the workspace.",
        title: "Progress update",
      }];
      turn.executionItems = turn.steps;
      if (completed) {
        turn.completedAt = new Date(Date.UTC(2026, 6, 4, 12, 1, 2)).toISOString();
        turn.finalAnswer = {
          id: "final-live",
          role: "assistant",
          text: "Inspection complete.",
          timestamp: turn.completedAt,
        };
      }
      if (totalTokens) {
        turn.usage = { totalTokens };
      }
      return timeline;
    };
    stores.chatStore.load = vi.fn(async () => timelineFor(false));
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    let toggle = await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const conversation = document.querySelector<HTMLElement>(".react-conversation-view")!;
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, value: 800, writable: true },
    });
    const timelineRect = vi.spyOn(executionTimeline, "getBoundingClientRect").mockImplementation(() => ({
      bottom: toggle.getAttribute("aria-expanded") === "true" ? 400 : 50,
      height: toggle.getAttribute("aria-expanded") === "true" ? 400 : 50,
      left: 0,
      right: 760,
      top: 0,
      width: 760,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    const conversationRect = vi.spyOn(conversation, "getBoundingClientRect").mockImplementation(() => ({
      bottom: 600,
      height: 500,
      left: 0,
      right: 1_000,
      top: 100,
      width: 1_000,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    }));
    let animationFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrame = callback;
      return 1;
    });
    act(() => listener?.({ type: "timeline.patch", timeline: timelineFor(true) }));
    toggle = await screen.findByRole("button", { name: /Work performed Completed · 1 action/ });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    act(() => animationFrame?.(0));
    expect(conversation.scrollTop).toBe(450);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => listener?.({ type: "timeline.patch", timeline: timelineFor(true, 42) }));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    requestFrame.mockRestore();
    conversationRect.mockRestore();
    timelineRect.mockRestore();
  });

  it("does not reopen explicitly closed execution when the final answer arrives", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-user-closed",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Keep closed",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "commentary-user-closed",
      kind: "message",
      messagePhase: "commentary",
      modelCallId: "call-user-closed",
      sequence: 1,
      status: "completed",
      summary: "Working.",
      title: "Progress update",
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    turn.status = "completed";
    turn.finalAnswer = {
      id: "final-user-closed",
      role: "assistant",
      text: "Done.",
      timestamp: new Date(Date.UTC(2026, 6, 4, 12, 1, 2)).toISOString(),
    };
    act(() => listener?.({ type: "timeline.patch", timeline: { ...timeline, turns: [{ ...turn }] } }));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });

  it("keeps abnormal canonical execution expanded with recovery controls visible", async () => {
    const stores = createStores();
    const timeline = failedPlanTimeline();
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed Failed · 3 actions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const error = screen.getByRole("alert", { name: "Task execution failed" });
    expect(within(error).getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("keeps interrupted work visible without rendering a failure recovery card", async () => {
    const stores = createStores();
    const timeline = failedPlanTimeline();
    timeline.turns[0].status = "interrupted";
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("button", { name: /Work performed Interrupted/ })).toBeTruthy();
    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(screen.queryByRole("alert", { name: "Task execution failed" })).toBeNull();
  });

  it("sends a contextual recovery prompt for continue", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "Task execution failed" });
    await user.click(within(error).getByRole("button", { name: "Continue" }));

    expectTurnSubmit(stores.chatStore, "s1", {
      text: "Continue from where you were interrupted using the existing context and plan. Confirm the current progress first, then finish the remaining work.",
    });
  });

  it("dispatches retry as a correlated TinyOS command instead of a synthetic chat prompt", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = failedPlanTimeline();
    const capabilities = effectiveCapabilities("s1");
    capabilities.evaluatedTurnId = timeline.turns[0].id;
    capabilities.capabilities.agent.retry = { available: true };
    stores.chatStore.load = vi.fn(async () => timeline);
    stores.chatStore.loadTinyOsCapabilities = vi.fn(async () => capabilities);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "Task execution failed" });
    await user.click(within(error).getByRole("button", { name: "Retry current step" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "operation.retry",
      operation: { itemId: "error-failed-plan", turnId: timeline.turns[0].id },
      target: expect.objectContaining({ sessionId: "s1" }),
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("restarts a failed task in a new titled session", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "Task execution failed" });
    await user.click(within(error).getByRole("button", { name: "Start over" }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({ title: "Inspect the project and repo…" });
    expectTurnSubmit(stores.chatStore, "s2", { text: "Inspect the project and report findings" });
  });

  it("loads owner-associated image references through the artifact API before previewing", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-artifact",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Create a chart",
      status: "complete",
    }, {
      id: "a-artifact",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 1),
      text: "Chart complete",
      status: "complete",
      toolCalls: [{ id: "tool-chart", name: "chart.render", status: "complete", summary: "Chart rendered" }],
    }]);
    canonical.turns[0].steps[0].artifacts = [{
      fetchPath: "output/chart.png",
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      status: "completed",
      title: "chart.png",
    }];
    const loadArtifact = vi.fn(async () => ({
      artifact: {
        artifactId: "image-1",
        content: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        title: "chart.png",
      },
    }));
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).loadArtifact = loadArtifact;

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Preview chart.png" }));
    expect(loadArtifact).toHaveBeenCalledWith({ artifactId: "image-1", sessionKey: "s1" });
    const sidecar = await screen.findByLabelText("Sidecar");
    const image = await within(sidecar).findByRole("img", { name: "chart.png" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("creates only Browser or Terminal resource tabs and restores hidden Sidecar resources", async () => {
    const user = userEvent.setup();
    const stores = createStores({ sessions: [{
      chatId: "chat-1",
      id: "s1",
      status: "idle",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      workingDirectory: "D:/code/tinybot",
    }] });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    const sidecar = screen.getByLabelText("Sidecar");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    const menu = within(sidecar).getByRole("menu", { name: "Choose a resource" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).queryByText("Artifacts")).toBeNull();

    const terminal = within(menu).getByRole("menuitem", { name: /Terminal/ });
    await waitFor(() => expect(terminal.hasAttribute("disabled")).toBe(false));
    await user.click(terminal);
    expect(within(sidecar).getByRole("tab", { name: "PowerShell" })).toBeTruthy();

    await user.click(within(sidecar).getByRole("button", { name: "Hide Sidecar" }));
    expect(screen.queryByLabelText("Sidecar")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show Sidecar" }));
    expect(within(screen.getByLabelText("Sidecar")).getByRole("tab", { name: "PowerShell" })).toBeTruthy();
  });

  it("places message action buttons under each message on the role side", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u1");
    const assistantMessage = screen.getByTestId("message-a1");
    const userBody = userMessage.querySelector(".react-message__body");
    const assistantBody = assistantMessage.querySelector(".react-message__body");
    const userActions = userMessage.querySelector(".react-message__actions");
    const assistantActions = assistantMessage.querySelector(".react-message__actions");

    expect(userMessage.getAttribute("data-actions-placement")).toBe("bottom");
    expect(assistantMessage.getAttribute("data-actions-placement")).toBe("bottom");
    expect(userBody?.nextElementSibling).toBe(userActions);
    expect(assistantBody?.nextElementSibling).toBe(assistantActions);
    expect(userActions?.getAttribute("data-align")).toBe("right");
    expect(assistantActions?.getAttribute("data-align")).toBe("left");
  });

  it("keeps assistant messages as inline prose instead of rounded bubbles", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(/\.react-message__body\s*{\s*min-width:\s*0;\s*padding:\s*2px 0;\s*}/s);
    expect(css).toMatch(/\.react-message-reasoning\s*{[^}]*margin-bottom:\s*10px;[^}]*color:\s*var\(--color-muted\);/s);
    expect(css).not.toMatch(/\.react-message-reasoning\s*{[^}]*padding-left:/s);
    expect(css).not.toMatch(/\.react-message-reasoning\s*{[^}]*border-left:/s);
    expect(css).toMatch(
      /\.react-message\[data-role="user"\]\s*{[^}]*justify-self:\s*end;[^}]*max-width:\s*min\(680px, 92%\);[^}]*width:\s*fit-content;/s,
    );
    expect(css).toMatch(
      /\.react-message\[data-role="user"\] \.react-message__body\s*{[^}]*border:\s*1px solid var\(--color-hairline\);[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--color-surface-card\);[^}]*padding:\s*12px 14px;/s,
    );
  });

  it("does not use colored left accent strips on error cards", () => {
    const css = readWorkbenchCss();

    expect(css).not.toMatch(/\.react-error-recovery\s*{[^}]*border-left:/s);
    expect(css).not.toMatch(/\.react-canonical-scoped-errors\s*{[^}]*border-left:/s);
  });

  it("uses configurable sans-serif assistant prose and modern monospace code", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.react-message-markdown\s*{[^}]*font-family:\s*var\(--font-ui\);/s,
    );
    expect(css).toContain('Inter, "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC"');
    expect(css).toMatch(
      /--font-code:\s*"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace;/,
    );
    expect(css).toMatch(
      /\.react-message-markdown \[data-streamdown="inline-code"\]\s*{[^}]*font-family:\s*var\(--font-code\);/s,
    );
    expect(css).toMatch(
      /\.react-message-markdown \[data-streamdown="code-block-header"\]\s*{[^}]*font-family:\s*var\(--font-code\);/s,
    );
    expect(css).toMatch(
      /\.react-message-markdown \[data-streamdown="code-block-body"\] pre,\s*\.react-message-markdown \[data-streamdown="code-block-body"\] code\s*{[^}]*font-family:\s*var\(--font-code\);/s,
    );
  });

  it("renders assistant Markdown tables instead of raw pipe text", async () => {
    const stores = createStores();
    const markdownMessages: ReactChatMessage[] = [
      {
        id: "a-table",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
        text: "| Step | Status |\n| --- | --- |\n| **spawn_agent** | complete |",
        status: "complete",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, markdownMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Step" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(within(table).getByText("spawn_agent").tagName.toLowerCase()).toBe("strong");
    expect(screen.queryByText(/\| Step \| Status \|/)).toBeNull();
  });

  it("limits rich Markdown rendering to assistant answer text", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [
      {
        id: "u-markdown",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "**keep user syntax literal**",
        status: "complete",
      },
      {
        id: "a-markdown",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
        text: "**format the answer**",
        reasoningText: "**keep reasoning syntax literal**",
        status: "complete",
      },
    ] satisfies ReactChatMessage[]));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u-markdown");
    const assistantMessage = await screen.findByTestId("message-a-markdown");
    expect(userMessage.querySelector("strong")).toBeNull();
    expect(within(userMessage).getByText("**keep user syntax literal**")).toBeTruthy();
    await user.click(within(assistantMessage).getByRole("button", { name: "Reasoning" }));
    expect(assistantMessage.querySelector(".react-message-reasoning strong")).toBeNull();
    expect(within(assistantMessage).getByText("**keep reasoning syntax literal**")).toBeTruthy();
    expect(assistantMessage.querySelector(".react-message-markdown strong")?.textContent).toBe("format the answer");
  });

  it("copies individual message text from message actions", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const copyMessages: ReactChatMessage[] = [
      {
        id: "a-copy",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Visible answer.",
        reasoningText: "Hidden planning.",
        contextReferences: [{ id: "ctx-1", kind: "reference", title: "Context", detail: "Context detail" }],
        status: "complete",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, copyMessages));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const assistantMessage = await screen.findByTestId("message-a-copy");
    await user.click(within(assistantMessage).getByRole("button", { name: "Copy message" }));

    expect(writeText).toHaveBeenCalledWith("Visible answer.");
  });

  it("switches to the branched session after branching from a message", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const branchedSession = {
      id: "s2",
      chatId: "chat-2",
      title: "Branch from Yes",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "idle" as const,
    };
    const branchMessages: ReactChatMessage[] = [
      {
        id: "b1",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Branch loaded",
        status: "complete",
      },
    ];
    stores.chatStore.branchFromMessage = vi.fn(async () => branchedSession);
    const sourceMessages: ReactChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "Yes.",
        status: "complete",
        turnStatus: "completed",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, sessionId === "s2" ? branchMessages : sourceMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const assistantMessage = await screen.findByTestId("message-a1");
    await user.click(within(assistantMessage).getByRole("button", { name: "Branch from here" }));

    expect(stores.chatStore.branchFromMessage).toHaveBeenCalledWith("s1", "a1");
    expect(await screen.findByRole("heading", { name: "Branch from Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Branch from Yes" })).toBeTruthy();
    expect(screen.getByText("Branch loaded")).toBeTruthy();
  });

  it("shows branch actions when a live assistant message completes", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
      status: "running" as const,
    };
    const completedSession = {
      ...runningSession,
      status: "idle" as const,
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
    };
    const assistantMessages: ReactChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
        text: "Yes.",
        status: "complete",
        turnStatus: "running",
      },
    ];
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([completedSession]);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, assistantMessages));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const assistantMessage = await screen.findByTestId("message-a1");
    expect(within(assistantMessage).queryByRole("button", { name: "Branch from here" })).toBeNull();

    subscribed?.({
      type: "timeline.patch",
      timeline: timelineFromReactMessages("s1", [{ ...assistantMessages[0], turnStatus: "completed" }]),
    });

    await waitFor(() => expect(within(assistantMessage).getByRole("button", { name: "Branch from here" })).toBeTruthy());
  });

  it("sends composer text through the chat store", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Hello from React");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", { reasoningEffort: "medium", text: "Hello from React" });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("sends native files as structured references without exposing paths in user text", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    nativeFilePickerMocks.pickDesktopChatFiles.mockResolvedValueOnce([{
      name: "notes.md",
      path: "C:\\Users\\tester\\notes.md",
      mimeType: "text/markdown",
      sizeBytes: 16,
    }]);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(nativeFilePickerMocks.pickDesktopChatFiles).toHaveBeenCalledTimes(1));
    expect((input as HTMLTextAreaElement).value).toBe("");
    await user.type(input, "Review this file");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      references: [{
        detail: "MARKDOWN - 16 Bytes",
        kind: "reference",
        rawPath: "C:\\Users\\tester\\notes.md",
        title: "notes.md",
        type: "tinyos.file",
      }],
      text: "Review this file",
    });
  });

  it("renders native file metadata without exposing its absolute path", async () => {
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-native-file",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "文件中的内容是什么",
      status: "complete",
    }]);
    timeline.turns[0].userMessage.references = [{
      detail: "MARKDOWN - 1.67 KB",
      kind: "reference",
      rawPath: "D:\\code\\tinybot\\test\\AI_Agent_第一性原理_文档.md",
      title: "AI_Agent_第一性原理_文档.md",
      type: "tinyos.file",
    }];
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-u-native-file");
    const attachments = within(message).getByLabelText("Attachments");
    expect(message.textContent).toContain("文件中的内容是什么");
    expect(attachments.textContent).toContain("AI_Agent_第一性原理_文档.md");
    expect(attachments.textContent).toContain("MARKDOWN - 1.67 KB");
    expect(message.textContent).not.toContain("D:\\code\\tinybot\\test");
    expect(message.textContent).not.toContain("Files mentioned by the user");
  });

  it("queues composer text while the active session is running", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize after this run{enter}");

    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.parentElement?.classList.contains("react-composer-drop-target")).toBe(true);
    expect(queuedInputs.textContent).toContain("Summarize after this run");
    expect(queuedInputs.textContent).toContain("Waiting");
    expect(within(queuedInputs).getByRole("button", { name: "Interrupt" })).toBeTruthy();
    expect(screen.queryByText("Interrupt current task")).toBeNull();
    expect(screen.queryByText("Queue as next turn")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("restores the normal send action when the canonical timeline is terminal", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByText("I ran a tool.");
    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "Start another turn");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expectTurnSubmit(stores.chatStore, "s1", { reasoningEffort: "medium", text: "Start another turn" });
    expect(screen.queryByRole("button", { name: "Interrupt current task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue as next turn" })).toBeNull();
  });

  it("interrupts the canonical active turn even when the session summary is stale", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    nativeFilePickerMocks.pickDesktopChatFiles.mockResolvedValueOnce([{
      name: "new-api.md",
      path: "C:\\Users\\tester\\new-api.md",
      mimeType: "text/markdown",
      sizeBytes: 32,
    }]);
    const staleIdleSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "idle" as const,
    };
    const stores = createStores({ sessions: [staleIdleSession] });
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [{
        id: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        description: "DeepSeek",
        default: true,
      }, {
        id: "deepseek-v4-pro",
        label: "deepseek-v4-pro",
        description: "DeepSeek",
      }]),
    };
    const runningTimeline = await stores.chatStore.load("s1");
    const active = runningTimeline.turns[runningTimeline.turns.length - 1];
    active.status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    let confirmCancellation: (() => void) | undefined;
    stores.chatStore.dispatch = vi.fn(async (command) => {
      if (command.kind === "agent.cancel") {
        await new Promise<void>((resolve) => {
          confirmCancellation = resolve;
        });
      }
    });
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Select model" }).textContent).toContain("deepseek-v4-flash"));
    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Keep this queued for later{enter}");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(nativeFilePickerMocks.pickDesktopChatFiles).toHaveBeenCalledTimes(1));
    await user.type(input, "Use the new API instead{enter}");
    const interruptRow = screen.getByText("Use the new API instead").closest(".react-queued-input");
    expect(interruptRow).not.toBeNull();
    await user.click(within(interruptRow as HTMLElement).getByRole("button", { name: "Interrupt" }));

    const cancelCommand = vi.mocked(stores.chatStore.dispatch).mock.calls
      .map(([command]) => command)
      .find((command) => command.kind === "agent.cancel");
    expect(cancelCommand).toEqual(expect.objectContaining({
      target: expect.objectContaining({ sessionId: "s1", turnId: active.id }),
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("Interrupting the current response");

    act(() => subscribed?.({
      eventType: "agent.turn.interrupted",
      type: "agent.event",
    }));
    act(() => subscribed?.({
      eventType: "agent.turn.interrupted",
      type: "agent.event",
    }));
    await waitFor(() => expect(vi.mocked(stores.sessionStore.list).mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);

    act(() => confirmCancellation?.());

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
      references: [{
        detail: "MARKDOWN - 32 Bytes",
        kind: "reference",
        rawPath: "C:\\Users\\tester\\new-api.md",
        title: "new-api.md",
        type: "tinyos.file",
      }],
      text: "Use the new API instead",
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(1);
    await waitFor(() => expect(screen.getByLabelText("Queued inputs").textContent).not.toContain("Use the new API instead"));
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("Keep this queued for later");
  });

  it("deletes queued composer text before it is sent", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    await mockLatestTurnStatus(stores.chatStore, "running");
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Delete me{enter}");
    await user.click(screen.getByRole("button", { name: /delete queued input/i }));

    expect(screen.queryByLabelText("Queued inputs")).toBeNull();
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("enforces the queued input limit while running", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    await mockLatestTurnStatus(stores.chatStore, "running");
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    for (const message of ["one", "two", "three", "four", "five", "six"]) {
      await user.type(input, `${message}{enter}`);
    }

    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.querySelectorAll(".react-queued-input")).toHaveLength(5);
    expect(queuedInputs.textContent).not.toContain("six");
    expect(screen.getByText("Already have 5 queued messages. Wait for processing or delete one before sending more.")).toBeTruthy();
  });

  it("dispatches one queued composer input after agent turn completion", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const idleSession = { ...runningSession, status: "idle" as const };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([idleSession])
      .mockResolvedValue([idleSession]);
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "first queued{enter}");
    await user.type(input, "second queued{enter}");
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);

    subscribed?.({ type: "agent.event", eventType: "agent.turn.completed" });

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      text: "first queued",
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(1);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).not.toContain("first queued");
    expect(queuedInputs.textContent).toContain("second queued");

    subscribed?.({ type: "agent.event", eventType: "agent.turn.completed" });

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      text: "second queued",
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(2);
    expect(screen.queryByLabelText("Queued inputs")).toBeNull();
  });

  it("keeps queued input waiting after structured message completion until the turn completes", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const idleSession = { ...runningSession, status: "idle" as const };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([idleSession])
      .mockResolvedValue([idleSession]);
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "queued after full turn{enter}");

    subscribed?.({ type: "agent.event", eventType: "message.completed" });

    expect(stores.sessionStore.list).toHaveBeenCalledTimes(1);
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("queued after full turn");

    subscribed?.({ type: "agent.event", eventType: "agent.turn.completed" });

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      text: "queued after full turn",
    }));
  });

  it("ignores legacy completion events that carry a message", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "queued after event message{enter}");

    subscribed?.({ type: "message.completed" });

    expect(screen.queryByTestId("message-assistant-completed")).toBeNull();
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("queued after event message");
  });

  it("ignores legacy completion events for queued input dispatch", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "after event{enter}");

    subscribed?.({ type: "message.completed" });

    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    expect(stores.sessionStore.list).toHaveBeenCalledTimes(1);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).toContain("after event");
    expect(queuedInputs.textContent).toContain("Waiting");
  });

  it("pauses queued inputs after a failed agent turn", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const failedSession = { ...runningSession, status: "failed" as const };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([failedSession])
      .mockResolvedValue([failedSession]);
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "retry later{enter}");

    subscribed?.({ type: "agent.event", eventType: "agent.turn.failed" });

    await waitFor(() => expect(screen.getByLabelText("Queued inputs").textContent).toContain("Paused"));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("pauses queued inputs on stop and resumes one input manually", async () => {
    const user = userEvent.setup();
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const idleSession = { ...runningSession, status: "idle" as const };
    const stores = createStores({ sessions: [runningSession] });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([idleSession])
      .mockResolvedValue([idleSession]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "resume first{enter}");
    await user.type(input, "resume second{enter}");
    await user.click(screen.getByRole("button", { name: "Stop generation" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.cancel",
      source: { control: "stop-response", surface: "chat" },
      target: expect.objectContaining({ sessionId: "s1" }),
    }));
    await waitFor(() => expect(screen.getByLabelText("Queued inputs").textContent).toContain("Paused"));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Resume queue" }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      text: "resume first",
    }));
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).not.toContain("resume first");
    expect(queuedInputs.textContent).toContain("resume second");
    expect(queuedInputs.textContent).toContain("Paused");
  });

  it("shares cancellation lifecycle state without rendering transient command status", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const runningSession = {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "running" as const,
    };
    const stores = createStores({ sessions: [runningSession] });
    await mockLatestTurnStatus(stores.chatStore, "running");
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "keep this queued{enter}");
    const command = createTinyOsAgentCancelCommand({
      commandId: "command-shortcut-1",
      issuedAt: "2026-07-04T12:00:00.000Z",
      sessionId: "s1",
      source: { control: "keyboard-shortcut", surface: "chat" },
      turnId: "turn-1",
    });

    act(() => subscribed?.({ command, type: "command.dispatched" }));

    expect(screen.queryByText(/Sending cancel command/)).toBeNull();
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("Paused");

    act(() => subscribed?.({ commandId: command.commandId, type: "command.accepted" }));

    expect(screen.queryByText(/Waiting for runtime confirmation/)).toBeNull();

    act(() => subscribed?.({ commandId: command.commandId, type: "command.canonical-updated" }));

    await waitFor(() => expect(stores.chatStore.load).toHaveBeenCalledTimes(2));
  });

  it("renders the optimistic user message immediately after send", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    let sent = false;
    const optimisticMessages: ReactChatMessage[] = [{
      id: "local-user",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "Hello immediately",
      status: "complete",
    }];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(
      sessionId,
      sent ? optimisticMessages : [],
    ));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    mockTurnSubmit(stores.chatStore, async () => {
      sent = true;
      subscribed?.({ type: "message-sent", message: optimisticMessages[0] });
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Hello immediately");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect((await screen.findByTestId("message-local-user")).textContent).toContain("Hello immediately");
  });

  it("reconciles an optimistic message only by the canonical client event id", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    const optimisticMessage: ReactChatMessage = {
      id: "client-message-1",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "  Normalize this prompt  ",
      status: "complete",
    };
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    mockTurnSubmit(stores.chatStore, async () => {
      subscribed?.({ type: "message-sent", message: optimisticMessage });
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);
    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Normalize this prompt");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByTestId("message-client-message-1")).toBeTruthy();

    const canonical = timelineFromReactMessages("s1", [{
      id: "durable-user-1",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 1),
      text: "Normalize this prompt",
      status: "complete",
    }]);
    canonical.turns[0].userMessage = {
      ...canonical.turns[0].userMessage,
      clientEventId: "client-message-1",
    } as typeof canonical.turns[0]["userMessage"];
    subscribed?.({ type: "timeline.patch", timeline: canonical });

    await waitFor(() => expect(screen.queryByTestId("message-client-message-1")).toBeNull());
    expect(screen.getByTestId("message-durable-user-1").textContent).toContain("Normalize this prompt");
  });

  it("preserves the optimistic first message while a pending session is being created", async () => {
    const user = userEvent.setup();
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores({ sessions: [] });
    const pendingSession = {
      id: "pending:1",
      title: "New session",
      updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      status: "running" as const,
    };
    const optimisticMessage: ReactChatMessage = {
      id: "local-user",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "Summarize this pending chat",
      status: "complete",
    };
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([pendingSession]);
    stores.sessionStore.create = vi.fn(async () => pendingSession);
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });
    mockTurnSubmit(stores.chatStore, async () => {
      subscribed?.({ type: "message-sent", message: optimisticMessage });
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByText("No sessions yet.");
    await user.click(screen.getByRole("button", { name: "New chat" }));
    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize this pending chat");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect((await screen.findByTestId("message-local-user")).textContent).toContain("Summarize this pending chat");
    expect(screen.queryByText("No sessions yet.")).toBeNull();
  });

  it("renders assistant thinking and context separately from the answer", async () => {
    const stores = createStores();
    const streamingMessages: ReactChatMessage[] = [
      {
        id: "assistant-live",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        reasoningText: "I am checking the available context.",
        text: "Here is the answer.",
        status: "streaming",
        contextReferences: [{
          id: "context-1",
          kind: "reference",
          title: "Project note",
          detail: "Use current backend contracts.",
          sourcePath: "docs/context.md",
          sourceLine: 12,
        }],
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, streamingMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-assistant-live");
    const reasoning = within(message).getByLabelText("Reasoning");
    expect(within(reasoning).getByRole("button", { name: "Thinking" }).getAttribute("aria-expanded")).toBe("true");
    expect(reasoning.textContent).toContain("I am checking the available context.");
    expect(within(message).getByLabelText("Context").textContent).toContain("Project note");
    expect(within(message).getByLabelText("Context").textContent).toContain("Use current backend contracts.");
    expect(within(message).getByLabelText("Agent is responding")).toBeTruthy();
    expect(message.querySelector(".react-message-markdown")?.textContent).toContain("Here is the answer.");
  });

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
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeTruthy();

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize docs");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "pending:1", {
      reasoningEffort: "medium",
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

  it("uses settings-backed model options instead of sample model defaults", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        {
          id: "deepseek-chat",
          label: "deepseek-chat",
          description: "DeepSeek",
          default: true,
        },
        {
          id: "deepseek-reasoner",
          label: "deepseek-reasoner",
          description: "DeepSeek",
        },
      ]),
    };
    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    expect(modelTrigger.textContent).toContain("deepseek-chat");
    await user.click(modelTrigger);
    await user.click(screen.getByRole("button", { name: /Model deepseek-chat/ }));

    expect(screen.getByRole("option", { name: /deepseek-reasoner/i })).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();

    await user.click(screen.getByRole("option", { name: /deepseek-reasoner/i }));
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-reasoner"));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-reasoner");
    expect(stores.sessionStore.setModel).toHaveBeenCalledWith("s1", "deepseek-reasoner");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Use a specific model");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      model: "deepseek-reasoner",
      reasoningEffort: "medium",
      text: "Use a specific model",
    });
  });

  it("persists composer effort and submits it as an explicit turn setting", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [{
        id: "gpt-5.6",
        label: "gpt-5.6",
        description: "OpenAI",
        default: true,
      }]),
    };
    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Select model" }));
    await user.click(screen.getByRole("button", { name: /Effort Medium/ }));
    await user.click(screen.getByRole("option", { name: /Extra High/ }));

    expect(window.localStorage.getItem("tinybot.ui.chat.composer-reasoning-effort")).toBe("xhigh");
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Solve this carefully");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      text: "Solve this carefully",
    });
  });

  it("restores each Thread model when switching conversations", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [
        {
          id: "s1",
          chatId: "chat-1",
          title: "Reasoning thread",
          updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
          status: "idle",
          model: "deepseek-reasoner",
        },
        {
          id: "s2",
          chatId: "chat-2",
          title: "Chat thread",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 0, 0),
          status: "idle",
          model: "deepseek-chat",
        },
      ],
    });
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        { id: "deepseek-chat", label: "deepseek-chat" },
        { id: "deepseek-reasoner", label: "deepseek-reasoner" },
      ]),
    };

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-reasoner"));

    await user.click(screen.getByRole("button", { name: "Chat thread" }));
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-chat"));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-chat");
  });

  it("restores a valid current model and replaces a stale one", async () => {
    const stores = createStores();
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        {
          id: "deepseek-chat",
          label: "deepseek-chat",
          description: "DeepSeek",
          default: true,
        },
        {
          id: "deepseek-reasoner",
          label: "deepseek-reasoner",
          description: "DeepSeek",
        },
      ]),
    };
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "deepseek-reasoner");

    const view = render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    expect((await screen.findByRole("button", { name: "Select model" })).textContent).toContain("deepseek-reasoner");

    view.unmount();
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "removed-model");
    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    expect((await screen.findByRole("button", { name: "Select model" })).textContent).toContain("deepseek-chat");
    await waitFor(() => expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-chat"));
  });

  it("stops the active running session from the composer", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Stop generation" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.cancel",
      source: { control: "stop-response", surface: "chat" },
      target: expect.objectContaining({ sessionId: "s1" }),
    }));
  });

  it("shows stop generation from the canonical active turn when the session list is stale", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Stop generation" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.cancel",
      target: expect.objectContaining({ sessionId: "s1", turnId: runningTimeline.turns[runningTimeline.turns.length - 1].id }),
    }));
  });

  it("interrupts the canonical active turn with Escape from the Chat surface", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Stop generation" });
    fireEvent.keyDown(await screen.findByRole("textbox", { name: /message/i }), { key: "Escape" });

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.cancel",
      source: { control: "stop-response", surface: "chat" },
      target: expect.objectContaining({ turnId: runningTimeline.turns[runningTimeline.turns.length - 1].id }),
    }));
  });

  it("hides run controls and the queue notice from the Chat surface", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    const run = runningTimeline.turns[runningTimeline.turns.length - 1];
    run.status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    const capabilities = effectiveCapabilities("s1");
    capabilities.evaluatedTurnId = run.id;
    vi.mocked(stores.chatStore.loadTinyOsCapabilities).mockResolvedValue(capabilities);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("button", { name: "Stop generation" })).toBeTruthy();
    expect(screen.queryByLabelText("Agent turn controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByText("任务执行中；此时发送的新消息会排队，并在当前步骤结束后送达。")).toBeNull();
  });

  it("disables cancellation with the backend-authored unavailable reason", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const runningTimeline = await stores.chatStore.load("s1");
    runningTimeline.turns[runningTimeline.turns.length - 1].status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    vi.mocked(stores.chatStore.loadTinyOsCapabilities).mockResolvedValue(effectiveCapabilities("s1", false));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const stop = await screen.findByRole("button", { name: /Stop generation unavailable/ });
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(stop.getAttribute("title")).toBe("Not supported."));
    expect(stores.chatStore.dispatch).not.toHaveBeenCalled();
  });

  it("sends long pasted content through the Claude-style composer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    const pastedText = Array.from({ length: 42 }, (_, index) => `word${index}`).join(" ");
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === "text" ? pastedText : "",
      },
    });

    expect(screen.getByText("Pasted text")).toBeTruthy();
    expect(screen.getByText("42 words")).toBeTruthy();

    await user.type(input, "Summarize this");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      text: `Summarize this\n\nPasted content:\n${pastedText}`,
    });
    expect(screen.queryByText("Pasted text")).toBeNull();
  });

  it("does not reload messages for socket error events", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    expect(stores.chatStore.load).toHaveBeenCalledTimes(1);

    subscribed?.({ type: "socket-error" });
    subscribed?.({ type: "error" });

    expect(stores.chatStore.load).toHaveBeenCalledTimes(1);
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

  it("defines reduced-motion fallbacks for chat motion primitives", () => {
    const css = readWorkbenchCss();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("react-list-enter");
    expect(css).toContain("react-drawer-enter");
    expect(css).toContain("react-stepper-current");
    expect(css).toContain(".react-session-row[data-dissolving=\"true\"]");
    expect(css).toContain("transition-duration: 140ms");
    expect(css).not.toContain("react-session-particle-burst");
    expect(css).not.toContain(".react-session-row__particles");
  });

  it("applies a warm border glow treatment to the composer panel", () => {
    const css = readWorkbenchCss();
    const inputSource = readFileSync("src/components/ui/claude-style-ai-input.tsx", "utf8");

    expect(inputSource).toContain("function handlePanelPointerMove");
    expect(inputSource).toContain("--claude-ai-panel-glow-x");
    expect(inputSource).toContain("--claude-ai-panel-glow-y");
    expect(inputSource).toContain("--claude-ai-panel-glow-opacity");
    expect(css).toContain("--claude-ai-panel-glow-opacity: 0");
    expect(css).toContain("--claude-ai-panel-glow-x: 50%");
    expect(css).toContain("--claude-ai-panel-glow-y: 100%");
    expect(css).toContain("overflow: visible");
    expect(css).toContain(".claude-ai-input__panel::before");
    expect(css).toContain("circle at var(--claude-ai-panel-glow-x) var(--claude-ai-panel-glow-y)");
    expect(css).toContain("var(--color-warning) 0");
    expect(css).toContain("var(--color-primary) 24px");
    expect(css).toContain("padding: 2px");
    expect(css).toContain("transition: opacity 260ms var(--motion-ease-standard)");
    expect(css).toContain("border-color: color-mix(in srgb, var(--color-primary) 24%, var(--color-hairline))");
    expect(css).toContain("var(--color-primary)");
    expect(css).toContain("var(--color-warning)");
    expect(css).toContain("-webkit-mask-composite: xor");
    expect(css).toContain(".claude-ai-input__panel:focus-within");
    expect(css).toContain(".claude-ai-input__context-usage");
    expect(css).toContain(".claude-ai-input__context-usage-tip");
    expect(inputSource).toContain("strokeDasharray={`${view.percent} 100`}");
  });

  it("uses a restrained 180ms fade and short horizontal exit for session deletion", () => {
    const css = readWorkbenchCss();
    const source = readFileSync("src/react-workbench/chat/ChatPage.tsx", "utf8");

    expect(source).toContain("const SESSION_DELETE_DISSOLVE_MS = 180;");
    expect(source).not.toContain("SESSION_DELETE_PARTICLE");
    expect(css).toContain(".react-session-row[data-dissolving=\"true\"] {");
    expect(css).toContain("opacity: 0");
    expect(css).toContain("transform: translateX(8px)");
    expect(css).not.toContain(".react-session-row__particle");
    expect(css).not.toContain("filter: blur(0.8px)");
  });
});
