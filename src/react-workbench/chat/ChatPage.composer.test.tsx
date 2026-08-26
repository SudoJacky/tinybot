// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, SettingsStore } from "../services";
import { buildAgentDefaultsSettings } from "../../app-core/settings/agentDefaultsSettings";
import type { ReactChatMessage } from "./messageActions";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  expectTurnSubmit,
  nativeFilePickerMocks,
  turnSubmitCommands,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
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

  it("loads workspace Skills and Agent Graph tools for the active workspace", async () => {
    const user = userEvent.setup();
    const workingDirectory = "D:\\Code\\tinybot";
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
    const loadCatalog = vi.fn(async () => ({
      mcpServers: [],
      skills: [{
        description: "Apple-style interface design and fluid physical motion.",
        id: "workspace:apple-design",
        name: "apple-design",
        path: `${workingDirectory}\\.agents\\skills\\apple-design\\SKILL.md`,
        source: "workspace",
      }],
      tools: [{
        available: true,
        description: "Run the saved incident analysis workflow.",
        displayName: "Incident analysis",
        enabled: true,
        id: "agent_graph.run.incident-analysis",
        name: "agent_graph.run.incident-analysis",
        source: "agent_graph",
      }],
    }));
    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        toolsStore={{ loadCatalog }}
      />,
    );

    await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect(loadCatalog).toHaveBeenCalledWith({ workingDirectory }));
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Incident analysis/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Tools" }));
    const input = screen.getByRole("textbox", { name: /message/i });
    await user.type(input, "/");

    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getByRole("option", { name: /\/compact Compact context/ })).toBeTruthy();
    expect(within(commands).getByRole("option", { name: /Apple Design.*Workspace/ })).toBeTruthy();
    expect(within(commands).queryByRole("option", { name: /\/plan|\/review|\/fix|\/test|\/explain/ })).toBeNull();

    await user.click(within(commands).getByRole("option", { name: /Apple Design.*Workspace/ }));

    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
    expect(within(input).getByText("Apple Design")).toBeTruthy();
    expect(screen.queryByLabelText("Composer attachments")).toBeNull();

    await user.keyboard("Polish this interaction");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      selectedSkills: ["apple-design"],
      selectedTools: ["agent_graph.run.incident-analysis"],
      text: "Polish this interaction",
    });
    expect(screen.queryByText("Apple Design")).toBeNull();
  });

  it("does not expose Agent Graph tools to a workspace-less conversation", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const loadCatalog = vi.fn(async () => ({
      mcpServers: [],
      skills: [],
      tools: [{
        available: true,
        displayName: "Incident analysis",
        enabled: true,
        id: "agent_graph.run.incident-analysis",
        name: "agent_graph.run.incident-analysis",
        source: "agent_graph",
      }],
    }));

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        toolsStore={{ loadCatalog }}
      />,
    );

    await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect(loadCatalog).toHaveBeenCalledWith({ workingDirectory: undefined }));
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: /Incident analysis/ })).toBeNull();
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
          cachedTokens: 4096,
          contextWindowRemainingTokens: 123724,
          contextWindowStrategy: "compact",
          contextWindowTokens: 128000,
          contextWindowUsedTokens: 4276,
          percent: 3.340625,
          promptTokens: 4216,
        },
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, usageMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 3% used, 97% left");
    expect(indicator.classList.contains("claude-ai-input__context-usage")).toBe(true);
    expect(indicator.getAttribute("aria-description")).toBe("Last call cache hit rate: 97%");
    expect(indicator.getAttribute("data-state")).toBe("normal");
    expect(indicator.textContent).toContain("4.3k / 128k tokens used");
    expect(indicator.textContent).toContain("Last call cache hit rate: 97%");
    expect(indicator.textContent).toContain("Strategy: compact");
  });

  it("renders a zero context window indicator before token usage arrives", async () => {
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const indicator = await screen.findByLabelText("Context window 0% used, 100% left");
    expect(indicator.classList.contains("claude-ai-input__context-usage")).toBe(true);
    expect(indicator.getAttribute("data-state")).toBe("normal");
    expect(indicator.textContent).toContain("0 tokens used");
    expect(indicator.textContent).toContain("Last call cache hit rate: No data");
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
            cachedTokens: 0,
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
    expect(indicator.textContent).toContain("Last call cache hit rate: 0%");

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

  it("sends composer text through the chat store", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false), { timeout: 3_000 });
    await user.type(input, "Hello from React");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expectTurnSubmit(stores.chatStore, "s1", { reasoningEffort: "medium", text: "Hello from React" });
      expect((input as HTMLTextAreaElement).value).toBe("");
    }, { timeout: 3_000 });
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

  it("sends managed images as multimodal references without embedding base64 in the command", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    nativeFilePickerMocks.pickDesktopChatFiles.mockResolvedValueOnce([{
      contentHash: "abc123",
      name: "diagram.png",
      path: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
      mimeType: "image/png",
      sizeBytes: 2048,
    }]);
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(nativeFilePickerMocks.pickDesktopChatFiles).toHaveBeenCalledTimes(1));
    await user.type(input, "Explain this diagram");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expectTurnSubmit(stores.chatStore, "s1", {
      reasoningEffort: "medium",
      references: [{
        contentHash: "abc123",
        detail: "PNG - 2 KB",
        kind: "reference",
        mimeType: "image/png",
        rawPath: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
        sizeBytes: 2048,
        title: "diagram.png",
        type: "tinyos.image",
      }],
      text: "Explain this diagram",
    });
    expect(JSON.stringify(vi.mocked(stores.chatStore.dispatch).mock.calls)).not.toContain("base64");
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
    const body = message.querySelector(".react-message__body");
    expect(message.textContent).toContain("文件中的内容是什么");
    expect(attachments.textContent).toContain("AI_Agent_第一性原理_文档.md");
    expect(attachments.textContent).toContain("MARKDOWN - 1.67 KB");
    expect(message.firstElementChild).toBe(attachments);
    expect(attachments.nextElementSibling).toBe(body);
    expect(body?.textContent).not.toContain("AI_Agent_第一性原理_文档.md");
    expect(message.textContent).not.toContain("D:\\code\\tinybot\\test");
    expect(message.textContent).not.toContain("Files mentioned by the user");
  });

  it("renders a managed image preview above the user message bubble", async () => {
    const tauriInternals = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        convertFileSrc: (path: string) => `asset://preview/${encodeURIComponent(path)}`,
      },
    });
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-managed-image",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "这是什么",
      status: "complete",
    }]);
    timeline.turns[0].userMessage.references = [{
      contentHash: "abc123",
      detail: "PNG - 15.17 KB",
      kind: "reference",
      mimeType: "image/png",
      rawPath: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
      sizeBytes: 15_534,
      title: "screen.png",
      type: "tinyos.image",
    }];
    stores.chatStore.load = vi.fn(async () => timeline);

    try {
      render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

      const message = await screen.findByTestId("message-u-managed-image");
      const attachments = within(message).getByLabelText("Attachments");
      const preview = within(attachments).getByRole("img", { name: "screen.png" });
      const body = message.querySelector(".react-message__body");
      expect(message.firstElementChild).toBe(attachments);
      expect(attachments.nextElementSibling).toBe(body);
      expect(body?.contains(preview)).toBe(false);
      expect(body?.textContent).toBe("这是什么");
      expect(within(message).queryByText("screen.png")).toBeNull();
      expect(preview.getAttribute("src")).toContain("asset://preview/");
    } finally {
      if (tauriInternals) {
        Object.defineProperty(window, "__TAURI_INTERNALS__", tauriInternals);
      } else {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    }
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
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "deepseek-chat");
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
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-chat");
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
        { id: "new-chat-default", label: "new-chat-default" },
      ]),
    };
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "new-chat-default");

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
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("new-chat-default");

    await user.click(screen.getByRole("button", { name: "Chat thread" }));
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-chat"));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("new-chat-default");
  });

  it("uses the saved default when creating a chat after viewing a populated Thread", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Flash thread",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "idle",
        model: "deepseek-v4-flash",
      }],
    });
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
        { id: "deepseek-v4-flash-vision-exp", label: "deepseek-v4-flash-vision-exp" },
      ]),
    };
    window.localStorage.setItem(
      "tinybot.ui.chat.composer-model",
      "deepseek-v4-flash-vision-exp",
    );

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    await waitFor(() => expect(modelTrigger.textContent).toContain("deepseek-v4-flash"));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model"))
      .toBe("deepseek-v4-flash-vision-exp");

    await screen.findByLabelText("Sessions");
    await user.click(screen.getByRole("button", { name: "Collapse session sidebar" }));
    await user.click(screen.getByRole("button", { name: "New conversation tab" }));

    expect(stores.sessionStore.create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /message/i }), "Use the saved model");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.sessionStore.create).toHaveBeenCalledWith({
      model: "deepseek-v4-flash-vision-exp",
    });
  });

  it("updates the new-conversation default when selecting a model before the first Turn", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Empty thread",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "idle",
        model: "deepseek-chat",
      }],
    });
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, []));
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        { id: "deepseek-chat", label: "deepseek-chat" },
        { id: "deepseek-reasoner", label: "deepseek-reasoner" },
      ]),
    };
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "deepseek-chat");

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 0, 0)}
        sessionStore={stores.sessionStore}
        settingsStore={settingsStore}
      />,
    );

    await screen.findByLabelText("Start a new chat");
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await user.click(screen.getByRole("button", { name: /Model deepseek-chat/ }));
    await user.click(screen.getByRole("option", { name: /deepseek-reasoner/i }));

    await waitFor(() => expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-reasoner"));
    expect(stores.sessionStore.setModel).toHaveBeenCalledWith("s1", "deepseek-reasoner");
  });

  it("restores a valid new-conversation default and clears a stale one", async () => {
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
    await waitFor(() => expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBeNull());
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
});
