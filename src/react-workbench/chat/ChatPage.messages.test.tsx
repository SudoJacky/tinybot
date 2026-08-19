// @vitest-environment happy-dom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../services";
import type { ReactChatMessage } from "./messageActions";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  mockTurnSubmit,
  readWorkbenchCss,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
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
});
