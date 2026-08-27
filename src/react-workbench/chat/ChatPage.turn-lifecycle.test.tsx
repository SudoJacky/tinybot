// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTinyOsAgentCancelCommand } from "../../app-core/chat/tinyOsCommand";
import type { ChatEvent, SettingsStore } from "../services";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  effectiveCapabilities,
  expectTurnSubmit,
  mockLatestTurnStatus,
  nativeFilePickerMocks,
  turnSubmitCommands,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
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
      reasoningEffort: "high",
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
      reasoningEffort: "high",
      text: "first queued",
    }));
    expect(turnSubmitCommands(stores.chatStore)).toHaveLength(1);
    const queuedInputs = screen.getByLabelText("Queued inputs");
    expect(queuedInputs.textContent).not.toContain("first queued");
    expect(queuedInputs.textContent).toContain("second queued");

    subscribed?.({ type: "agent.event", eventType: "agent.turn.completed" });

    await waitFor(() => expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "high",
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
      reasoningEffort: "high",
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
      reasoningEffort: "high",
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

    await waitFor(() => expect(vi.mocked(stores.chatStore.loadTinyOsCapabilities).mock.calls.length).toBeGreaterThanOrEqual(2));
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
});
