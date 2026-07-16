// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import type { ChatEvent, ChatStore, SessionStore, SessionSummary, SettingsStore } from "../services";
import type { DesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
import type { ReactChatMessage } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { createTinyOsAgentCancelCommand } from "../../app-core/chat/tinyOsCommandGateway";
import type { TinyOsEffectiveCapabilities } from "../../app-core/chat/tinyOsCapabilities";
import { timelineFromReactMessages } from "./testTimelineFixtures";

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("[data-test-style='workbench']").forEach((element) => element.remove());
  vi.useRealTimers();
});

function mountWorkbenchCss(): void {
  const style = document.createElement("style");
  style.dataset.testStyle = "workbench";
  style.textContent = readFileSync("src/react-workbench/styles/workbench.css", "utf8");
  document.head.append(style);
}

function dragTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
    get types() { return [...values.keys()]; },
  } as unknown as DataTransfer;
}

function effectiveCapabilities(sessionId: string, cancelAvailable = true): TinyOsEffectiveCapabilities {
  const unavailable = { available: false, reasonCode: "runtime_unsupported", reason: "Not supported." };
  const available = { available: true };
  return {
    schemaVersion: "tinybot.effective_capabilities.v1",
    sessionId,
    capabilities: {
      agent: { pause: unavailable, resume: unavailable, cancel: cancelAvailable ? available : unavailable, retry: unavailable },
      files: { read: available, requestChange: unavailable, directEdit: unavailable, save: unavailable },
      terminal: {
        contract: "retained_execution_v1",
        persistentPty: false,
        inspect: available,
        execute: unavailable,
        cancel: unavailable,
      },
      browser: {
        interactionRequires: "current_real_capture",
        structured: available,
        projectionContract: "structured_projection_v1",
        realCapture: unavailable,
        sessionContract: "browser_session_v1",
        sessionSnapshot: false,
        interact: unavailable,
      },
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

    await screen.findByRole("button", { name: /Execution details Running · 1 item/ });
    mountWorkbenchCss();
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    const executionContent = document.querySelector<HTMLElement>(".react-execution-timeline__content")!;
    expect(getComputedStyle(executionTimeline).height).toBe("max-content");
    expect(getComputedStyle(executionTimeline).borderTopWidth).toBe("0px");
    expect(getComputedStyle(executionTimeline).marginLeft).toBe("0px");
    expect(getComputedStyle(executionContent).paddingLeft).toBe("0px");
  });

  it("renders the React chat layout without legacy header actions", async () => {
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
    expect(screen.queryByText(/Agent · rust/i)).toBeNull();
  });

  it("opens and closes TinyOS from the Chat header with focus restoration", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const openButton = await screen.findByRole("button", { name: /^Open TinyOS/ });
    expect(openButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("TinyOS shared desktop")).toBeNull();

    fireEvent.click(openButton);

    const canvas = screen.getByLabelText("TinyOS shared desktop");
    mountWorkbenchCss();
    const canvasHeading = within(canvas).getByRole("heading", { name: "TinyOS" });
    expect(openButton.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(openButton).minWidth).toBe("44px");
    expect(document.querySelector(".react-chat-page")?.getAttribute("data-live-canvas-open")).toBe("true");
    expect(canvas.querySelector('[aria-label="Terminal window"]')).toBeTruthy();
    expect(canvas.textContent).toContain("Live workspace");
    expect(document.activeElement).toBe(canvasHeading);

    const closeButton = canvas.querySelector<HTMLButtonElement>('[aria-label="Close TinyOS desktop"]')!;
    expect(getComputedStyle(closeButton).minWidth).toBe("44px");
    fireEvent.click(closeButton);

    expect(canvas.isConnected).toBe(false);
    expect(openButton.getAttribute("aria-label")).toMatch(/^Open TinyOS/);
    expect(document.activeElement).toBe(openButton);
  });

  it("attaches a TinyOS file range as a visible composer chip and structured chat reference", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-tinyos-reference",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect this file",
      status: "complete" as const,
    }]);
    timeline.turns[0].steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "file-reference",
      kind: "tool_call",
      sequence: 1,
      status: "completed",
      title: "workspace.read_file",
      toolCall: {
        argsJson: { path: "src/main.ts", revision: "rev-1" },
        id: "file-reference",
        name: "workspace.read_file",
        resultPreview: "const value = 1;\nexport { value };",
      },
    }];
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /^Open TinyOS/ }));
    const filesWindow = screen.getByLabelText("Files window");
    await user.click(within(filesWindow).getByRole("button", { name: "const value = 1;" }));
    await user.click(within(filesWindow).getByRole("button", { name: "Attach src/main.ts · L1" }));

    const attachments = screen.getByLabelText("Composer attachments");
    expect(within(attachments).getByText("src/main.ts · L1")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Explain this line");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", expect.objectContaining({
      references: [expect.objectContaining({
        evidenceId: "file-reference",
        sourceLine: 1,
        sourceEndLine: 1,
        sourcePath: "src/main.ts",
        sourceText: "const value = 1;",
        title: "src/main.ts · L1",
        type: "tinyos.file",
        revision: "rev-1",
      })],
      text: "Explain this line",
    })));
    expect(screen.queryByText("src/main.ts · L1")).toBeNull();
  });

  it("attaches a dragged TinyOS file reference to the Chat composer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-tinyos-drag-reference",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect this file",
      status: "complete" as const,
    }]);
    timeline.turns[0].steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "file-drag-reference",
      kind: "tool_call",
      sequence: 1,
      status: "completed",
      title: "workspace.read_file",
      toolCall: {
        argsJson: { path: "src/drag.ts" },
        id: "file-drag-reference",
        name: "workspace.read_file",
        resultPreview: "export const dragged = true;",
      },
    }];
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /^Open TinyOS/ }));
    const filesWindow = screen.getByLabelText("Files window");
    await user.click(within(filesWindow).getByRole("button", { name: "export const dragged = true;" }));
    const source = within(filesWindow).getByRole("button", { name: /Attach src\/drag\.ts/ });
    const target = document.querySelector<HTMLElement>(".tinyos-composer-drop-target")!;
    const dataTransfer = dragTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(within(screen.getByLabelText("Composer attachments")).getByText("src/drag.ts · L1")).toBeTruthy();
  });

  it("opens exact timeline items in history and returns to the latest live frame", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    stores.chatStore.subscribe = vi.fn((_sessionId, nextListener) => {
      listener = nextListener;
      return () => undefined;
    });
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-live-canvas",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect the project",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.status = "running";
    turn.steps = [
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "canvas-file",
        kind: "tool_call",
        sequence: 1,
        status: "completed",
        title: "workspace.read_file",
        toolCall: {
          argsJson: { path: "src/main.ts" },
          id: "canvas-file-call",
          name: "workspace.read_file",
          resultPreview: "export const ready = true;",
        },
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "canvas-plan",
        kind: "plan",
        plan: {
          completed: 1,
          currentStep: "Verify output",
          steps: [
            { status: "completed", step: "Inspect files" },
            { status: "in_progress", step: "Verify output" },
          ],
          total: 2,
        },
        sequence: 2,
        status: "running",
        title: "Execution plan",
      },
    ];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /^Open TinyOS/ }));
    let canvas = screen.getByLabelText("TinyOS shared desktop");
    expect(within(canvas).getAllByText("Live workspace").length).toBeGreaterThan(0);
    expect(within(canvas).getByRole("heading", { name: "Execution plan" })).toBeTruthy();
    expect(within(canvas).getByText("Verify output")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open details for workspace.read_file" }));
    canvas = screen.getByLabelText("TinyOS shared desktop");
    expect(within(canvas).getByText("History")).toBeTruthy();
    expect(within(canvas).getByRole("article", { name: "Files window" })).toBeTruthy();
    expect(within(canvas).getAllByText("workspace.read_file").length).toBeGreaterThan(0);
    expect(within(canvas).getAllByText("src/main.ts").length).toBeGreaterThan(0);
    expect(within(canvas).getByText("export const ready = true;")).toBeTruthy();

    const memoryStep = {
      agentContext: { id: "main", title: "Tinybot", type: "main" } as const,
      id: "canvas-memory",
      kind: "memory" as const,
      sequence: 3,
      status: "running" as const,
      summary: "Searching saved project decisions",
      title: "memory.search",
      toolCall: { argsJson: { query: "Live Canvas" }, id: "canvas-memory-call", name: "memory.search" },
    };
    const nextSteps = [...turn.steps, memoryStep];
    const nextTimeline = {
      ...timeline,
      turns: [{ ...turn, executionItems: nextSteps, steps: nextSteps }],
    };
    act(() => listener?.({ timeline: nextTimeline, type: "agent_timeline_updated" } as ChatEvent));
    expect(within(canvas).getByText("History")).toBeTruthy();
    expect(within(canvas).getAllByText("src/main.ts").length).toBeGreaterThan(0);

    await user.click(within(canvas).getByRole("button", { name: "Return to Live" }));
    expect(within(canvas).getAllByText("Live workspace").length).toBeGreaterThan(0);
    expect(within(canvas).getByRole("article", { name: "Memory window" })).toBeTruthy();
    expect(within(canvas).getAllByText("memory.search").length).toBeGreaterThan(0);
    expect(within(canvas).getByRole("heading", { name: "TinyOS" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "会话" })).toBeTruthy();
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

  it("uses Text Type for chat empty states without changing the accessible copy", async () => {
    const stores = createStores();
    stores.sessionStore.list = vi.fn(async () => []);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sessionEmptyState = await screen.findByLabelText("No sessions yet.");
    const start = await screen.findByLabelText("Start a new chat");

    expect(sessionEmptyState.classList.contains("react-text-type")).toBe(true);
    expect(sessionEmptyState.getAttribute("data-text-type")).toBe("once");
    expect(sessionEmptyState.getAttribute("aria-label")).toBe("No sessions yet.");
    expect(within(sessionEmptyState).getByTestId("text-type-visual")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "新会话" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "新会话" })).toBeTruthy();
    expect(stores.sessionStore.create).not.toHaveBeenCalled();

    await user.type(input, "Hello from an empty app");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expectTurnSubmit(stores.chatStore, "s-new", {
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
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");

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
    const input = within(dialog).getByRole("textbox", { name: "Search chats or commands" }) as HTMLInputElement;

    expect(input.placeholder).toBe("搜索聊天或运行命令");
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
    await user.click(within(dialog).getByRole("button", { name: /New Chat/ }));

    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Chat search" })).toBeNull();
    expect(screen.getByRole("heading", { name: "新会话" })).toBeTruthy();
  });

  it("uses a raised start layout for an empty active session", async () => {
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const start = await screen.findByLabelText("Start a new chat");
    const composer = screen.getByRole("form", { name: "Message composer" });
    const input = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;

    expect(start.getAttribute("data-empty-session")).toBe("true");
    expect(screen.getByRole("heading", { name: "想让 Tinybot 做什么？" })).toBeTruthy();
    expect(composer.classList.contains("react-composer--raised")).toBe(true);
    expect(input.placeholder).toBe("输入任务，或粘贴/拖入文件");
    expect(screen.queryByLabelText("Select or create a session.")).toBeNull();
  });

  it("fills the composer from an empty-session suggestion without sending", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const start = await screen.findByLabelText("Start a new chat");
    const suggestion = within(start).getByRole("button", { name: "规划一个任务并列出执行步骤" });
    await user.click(suggestion);

    expect((screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement).value).toBe("规划一个任务并列出执行步骤");
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
  });

  it("keeps the normal bottom composer layout when a session has messages", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByText("Can you help?");
    const composer = screen.getByRole("form", { name: "Message composer" });

    expect(screen.queryByLabelText("Start a new chat")).toBeNull();
    expect(composer.classList.contains("react-composer--raised")).toBe(false);
    expect(screen.getByRole("textbox", { name: /message/i }).getAttribute("placeholder")).toBe("输入消息给 Tinybot");
    expect(message).toBeTruthy();
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

    const back = screen.getByRole("button", { name: "回到最新消息" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(conversation.lastElementChild!, "scrollIntoView", { configurable: true, value: scrollIntoView });
    await user.click(back);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
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
    expect(within(start).getByRole("heading", { name: "想让 Tinybot 做什么？" })).toBeTruthy();
    expect(within(start).getAllByRole("button")).toHaveLength(4);
    expect(within(start).getByRole("button", { name: "检查方案中可能遗漏的问题" })).toBeTruthy();
    const nextSuggestions = within(start).getByLabelText("Prompt suggestions");
    expect(nextSuggestions.textContent).toContain("规划一个任务并列出执行步骤");
    expect(nextSuggestions.textContent).toContain("检查方案中可能遗漏的问题");
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
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const sessionButton = await screen.findByRole("button", { name: "Planning notes" });
    const row = sessionButton.closest(".react-session-row") as HTMLElement | null;
    await user.hover(sessionButton);
    await user.click(screen.getByRole("button", { name: /delete Planning notes/i }));
    await user.click(screen.getByRole("button", { name: /confirm delete Planning notes/i }));
    mountWorkbenchCss();

    expect(stores.sessionStore.delete).toHaveBeenCalledWith("s1");
    expect(row?.dataset.dissolving).toBe("true");
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(getComputedStyle(row?.querySelector(".react-session-row__delete") as Element).position).toBe("absolute");
    expect(row?.querySelectorAll(".react-session-row__particle").length).toBeGreaterThanOrEqual(200);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Planning notes" })).toBeNull(), { timeout: 1000 });
  });

  it("keeps branch actions off user and tool-backed assistant messages", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u1");
    expect(within(userMessage).queryByRole("button", { name: /branch from here/i })).toBeNull();

    expect(within(screen.getByTestId("message-a1")).queryByRole("button", { name: /branch from here/i })).toBeNull();
    expect(within(screen.getByTestId("message-a2")).queryByRole("button", { name: /branch from here/i })).toBeNull();
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
    const reasoning = within(message).getByLabelText("思考过程");
    const reasoningToggle = within(reasoning).getByRole("button", { name: /^思考/ });
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
    const reasoning = within(message).getByLabelText("思考过程");
    const reasoningToggle = within(reasoning).getByRole("button", { name: "正在思考" });
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
    expect(currentStep?.querySelector(".react-agent-step__status")?.textContent).toBe("执行中");
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
    expect(drawer.textContent).toContain("Done");
  });

  it("shows canonical tool arguments, result, and approval fields in the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const detailedMessages: ReactChatMessage[] = [{
      id: "a-tool-details",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "I checked the workspace.",
      status: "complete",
      toolCalls: [{
        approvalId: "approval-1",
        approvalStatus: "approval_required",
        argsText: "{\"path\":\"src/main.ts\"}",
        childRunId: "child-run-1",
        delegateId: "delegate-1",
        delegateTask: "Review implementation",
        delegateTitle: "Code reviewer",
        delegateType: "review",
        finalOutput: "Reviewed implementation.",
        id: "tool-1",
        name: "workspace.read_file",
        parentRunId: "parent-run-1",
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
    expect(within(drawer).getByText("Approval")).toBeTruthy();
    expect(drawer.textContent).toContain("approval-1");
  });

  it("resolves pending approval steps from the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const dispatch = vi.fn(async () => undefined);
    const approvalMessages: ReactChatMessage[] = [{
      id: "a-approval",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Waiting for approval.",
      status: "complete",
      turnStatus: "running",
      toolCalls: [{
        approvalId: "approval-1",
        approvalStatus: "approval_required",
        id: "tool-approval",
        name: "shell",
        sessionKey: "websocket:chat-1",
        status: "approval_required",
        summary: "Run npm test",
      } as NonNullable<ReactChatMessage["toolCalls"]>[number]],
    }];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, approvalMessages));
    stores.chatStore.dispatch = dispatch;

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for shell" }));
    const drawer = screen.getByLabelText("Details drawer");

    expect(within(drawer).getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Allow for session" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Deny" })).toBeTruthy();

    await user.click(within(drawer).getByRole("button", { name: "Allow for session" }));

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      approval: { approvalId: "approval-1", approved: true, scope: "session" },
      kind: "approval.resolve",
      source: { control: "tool-approval", surface: "chat" },
      target: expect.objectContaining({ runId: "turn:a-approval", sessionId: "s1" }),
    }));
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
      correlation: { chat_id: "chat-1", run_id: "run-1", session_id: "s1" },
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
    canonical.turns[0].id = "run-1";
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

    fireEvent.change(within(card).getByLabelText("Destination"), { target: { value: "Singapore" } });
    fireEvent.change(within(card).getByLabelText("Nights"), { target: { value: "4" } });
    await user.click(within(card).getByRole("button", { name: "Save preferences" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      form: {
        formId: "travel-preferences-1",
        values: { destination: "Singapore", nights: 4 },
      },
      kind: "form.submit",
      source: { control: "chat-form", surface: "chat" },
      target: expect.objectContaining({ runId: "run-1", sessionId: "s1" }),
    }));
    expect(within(card).getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(true);
  });

  it("cancels active agent-ui forms through the TinyOS command gateway", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: { chat_id: "chat-1", run_id: "run-1", session_id: "s1" },
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
    canonical.turns[0].id = "run-1";
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
      target: expect.objectContaining({ runId: "run-1", sessionId: "s1" }),
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

    const plan = await screen.findByRole("region", { name: "执行计划" });
    const planToggle = within(plan).getByRole("button", { name: /执行计划/ });
    const details = screen.getByRole("button", { name: /Agent steps, 1 step/i });
    const error = screen.getByRole("alert", { name: "任务执行失败" });
    expect(plan.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(error));
    expect(planToggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(planToggle);
    expect(planToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(planToggle);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(error.textContent).toContain("执行达到迭代上限");
    expect(error.textContent).toContain("Read project files");
    expect(error.textContent).toContain("已完成 1 个步骤");
    expect(within(error).getByRole("button", { name: "继续执行" })).toBeTruthy();
    expect(within(error).getByRole("button", { name: "重试当前步骤" })).toBeTruthy();
    expect(within(error).getByRole("button", { name: "重新开始" })).toBeTruthy();

    await user.click(within(error).getByRole("button", { name: "查看详情" }));
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

    const toggle = await screen.findByRole("button", { name: /Execution details Completed · 4 items/ });
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
    expect(toolItem.querySelector(".react-agent-step")).not.toBeNull();
    expect(screen.getByText("I found the first file.")).toBeTruthy();
    expect(screen.getByText("Now I will verify it.")).toBeTruthy();
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

    let toggle = await screen.findByRole("button", { name: /Execution details Running · 1 item/ });
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
    toggle = await screen.findByRole("button", { name: /Execution details Completed · 1 item/ });
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

    const toggle = await screen.findByRole("button", { name: /Execution details Running · 1 item/ });
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

    const toggle = await screen.findByRole("button", { name: /Execution details Failed · 3 items/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const error = screen.getByRole("alert", { name: "任务执行失败" });
    expect(within(error).getByRole("button", { name: "继续执行" })).toBeTruthy();
  });

  it("sends a contextual recovery prompt for continue", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "任务执行失败" });
    await user.click(within(error).getByRole("button", { name: "继续执行" }));

    expectTurnSubmit(stores.chatStore, "s1", {
      text: "请从刚才中断的位置继续，沿用现有上下文和计划；先确认当前进度，再完成剩余任务。",
    });
  });

  it("dispatches retry as a correlated TinyOS command instead of a synthetic chat prompt", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = failedPlanTimeline();
    const capabilities = effectiveCapabilities("s1");
    capabilities.evaluatedRunId = timeline.turns[0].id;
    capabilities.capabilities.agent.retry = { available: true };
    stores.chatStore.load = vi.fn(async () => timeline);
    stores.chatStore.loadTinyOsCapabilities = vi.fn(async () => capabilities);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "任务执行失败" });
    await user.click(within(error).getByRole("button", { name: "重试当前步骤" }));

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

    const error = await screen.findByRole("alert", { name: "任务执行失败" });
    await user.click(within(error).getByRole("button", { name: "重新开始" }));

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
    const drawer = await screen.findByLabelText("Details drawer");
    const image = await within(drawer).findByRole("img", { name: "chart.png" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
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
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");

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
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");

    expect(css).not.toMatch(/\.react-error-recovery\s*{[^}]*border-left:/s);
    expect(css).not.toMatch(/\.react-canonical-scoped-errors\s*{[^}]*border-left:/s);
  });

  it("uses sans-serif assistant prose and modern monospace code", () => {
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");

    expect(css).toMatch(
      /\.react-message-markdown\s*{[^}]*font-family:\s*Inter, "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif;/s,
    );
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
    await user.click(within(assistantMessage).getByRole("button", { name: /^思考/ }));
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
        contextReferences: [{ id: "ctx-1", kind: "memory", title: "Memory", detail: "Context detail" }],
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

    expectTurnSubmit(stores.chatStore, "s1", { text: "Hello from React" });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("sends selected text files as bounded turn attachments", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const file = new File(["# Notes\nattached"], "notes.md", { type: "text/markdown" });
    await user.upload(await screen.findByLabelText("File attachments"), file);
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      text: "Review the attached files.",
      attachments: [{
        type: "text",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 16,
        content: "# Notes\nattached",
      }],
    });
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
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize after this run{enter}");

    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).toContain("Summarize after this run");
    expect(queuedInputs.textContent).toContain("Waiting");
    expect((input as HTMLTextAreaElement).value).toBe("");
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
      text: "first queued",
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(1);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).not.toContain("first queued");
    expect(queuedInputs.textContent).toContain("second queued");

    subscribed?.({ type: "agent.event", eventType: "agent.turn.completed" });

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
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
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "after approval{enter}");

    subscribed?.({ type: "message.completed" });

    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(0);
    expect(stores.sessionStore.list).toHaveBeenCalledTimes(1);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).toContain("after approval");
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
    stores.sessionStore.list = vi.fn()
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([failedSession]);
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
      text: "resume first",
    }));
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).not.toContain("resume first");
    expect(queuedInputs.textContent).toContain("resume second");
    expect(queuedInputs.textContent).toContain("Paused");
  });

  it("shares command lifecycle state for cancellation dispatched outside ChatPage", async () => {
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
      runId: "run-1",
      sessionId: "s1",
      source: { control: "keyboard-shortcut", surface: "chat" },
      turnId: "run-1",
    });

    act(() => subscribed?.({ command, type: "command.dispatched" }));

    expect(screen.getByText(/Sending cancel command/)).toBeTruthy();
    expect(screen.getByLabelText("Queued inputs").textContent).toContain("Paused");

    act(() => subscribed?.({ commandId: command.commandId, type: "command.accepted" }));

    expect(screen.getByText(/Waiting for runtime confirmation/)).toBeTruthy();

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
    await user.click(screen.getByRole("button", { name: "New Chat" }));
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
          id: "mem-1",
          kind: "memory",
          title: "Project note",
          detail: "Use current backend contracts.",
          sourcePath: "memory/MEMORY.md",
          sourceLine: 12,
        }],
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, streamingMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-assistant-live");
    const reasoning = within(message).getByLabelText("思考过程");
    expect(within(reasoning).getByRole("button", { name: "正在思考" }).getAttribute("aria-expanded")).toBe("true");
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
    await user.click(screen.getByRole("button", { name: "New Chat" }));
    expect(await screen.findByRole("heading", { name: "新会话" })).toBeTruthy();

    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "Summarize docs");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expectTurnSubmit(stores.chatStore, "pending:1", {
      text: "Summarize docs",
    }));
    expect(screen.queryByRole("heading", { name: "未选择会话" })).toBeNull();
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

    expect(screen.getByRole("option", { name: /deepseek-reasoner/i })).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();

    await user.click(screen.getByRole("option", { name: /deepseek-reasoner/i }));
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-reasoner"));
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Use a specific model");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      model: "deepseek-reasoner",
      text: "Use a specific model",
    });
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

  it("dispatches pause from Chat through the correlated run controller", async () => {
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
    const run = runningTimeline.turns[runningTimeline.turns.length - 1];
    run.status = "running";
    vi.mocked(stores.chatStore.load).mockResolvedValue(runningTimeline);
    const capabilities = effectiveCapabilities("s1");
    capabilities.evaluatedRunId = run.id;
    capabilities.capabilities.agent.pause = { available: true };
    vi.mocked(stores.chatStore.loadTinyOsCapabilities).mockResolvedValue(capabilities);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Pause" }));
    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.pause",
      source: { control: "chat-pause", surface: "chat" },
      target: expect.objectContaining({ runId: run.id, sessionId: "s1" }),
    }));
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
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");
    const textTypeCss = readFileSync("src/components/ui/TextType.css", "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(textTypeCss).toContain(".text-type__content");
    expect(textTypeCss).toContain(".text-type__cursor");
    expect(css).toContain("react-list-enter");
    expect(css).toContain("react-drawer-enter");
    expect(css).toContain("react-stepper-current");
    expect(css).toContain("react-session-dissolve");
    expect(css).toContain("react-session-particle-burst");
    expect(css).toContain(".react-session-row__particles");
  });

  it("applies a warm border glow treatment to the composer panel", () => {
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");
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

  it("uses a dense warm-white micro-particle burst for the session delete dissolve", () => {
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");
    const source = readFileSync("src/react-workbench/chat/ChatPage.tsx", "utf8");

    expect(source).toContain("const SESSION_DELETE_DISSOLVE_MS = 760;");
    expect(source).toContain("const SESSION_DELETE_PARTICLE_COUNT = 220;");
    expect(css).toContain(".react-session-row__particle");
    expect(css).toContain("--react-session-particle-color: rgb(255 255 255 / 96%)");
    expect(css).toContain("--react-session-particle-glow: rgb(255 255 255 / 72%)");
    expect(css).toContain("--react-session-particle-edge: rgb(165 154 134 / 34%)");
    expect(css).toContain("--particle-x");
    expect(css).toContain("--particle-y");
    expect(css).toContain("translate(calc(-50% + var(--particle-x))");
    expect(css).toContain(".react-session-row[data-dissolving=\"true\"] {");
    expect(css).toContain("overflow: visible");
    expect(css).toContain("width: var(--particle-size)");
    expect(css).toContain("animation: react-session-dissolve 760ms");
    expect(css).not.toContain("background: var(--particle-color)");
    expect(css).not.toContain("color-mix(in srgb, var(--particle-color)");
    expect(css).not.toContain("react-session-particle-drift");

    const shellDissolve = css.match(/@keyframes react-session-dissolve\s*{(?<body>[\s\S]*?)\n}/)?.groups?.body ?? "";
    expect(shellDissolve).toContain("background-color");
    expect(shellDissolve).not.toContain("translateX");
    expect(shellDissolve).not.toContain("opacity: 0");
  });
});
