// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import type { ChatEvent, ChatStore, SessionStore, SettingsStore } from "../services";
import type { ReactChatMessage } from "./messageActions";

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("[data-test-style='workbench']").forEach((element) => element.remove());
});

function mountWorkbenchCss(): void {
  const style = document.createElement("style");
  style.dataset.testStyle = "workbench";
  style.textContent = readFileSync("src/react-workbench/styles/workbench.css", "utf8");
  document.head.append(style);
}

function createStores(): { chatStore: ChatStore; sessionStore: SessionStore } {
  const sessions = [
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
      load: vi.fn(async () => messages),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      branchFromMessage: vi.fn(async () => sessions[0]),
      copyMarkdown: vi.fn(async () => "# Planning notes"),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

describe("ChatPage", () => {
  it("uses a denser font scale for the chat surface", async () => {
    mountWorkbenchCss();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const chat = await screen.findByLabelText("Chat");

    expect(getComputedStyle(chat).fontSize).toBe("13px");
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
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
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
    const conversationEmptyState = await screen.findByLabelText("Select or create a session.");

    expect(sessionEmptyState.classList.contains("react-text-type")).toBe(true);
    expect(sessionEmptyState.getAttribute("data-text-type")).toBe("once");
    expect(sessionEmptyState.querySelector("[aria-hidden='true']")?.textContent).toBe("No sessions yet.");
    expect(conversationEmptyState.classList.contains("react-text-type")).toBe(true);
    expect(conversationEmptyState.getAttribute("data-text-type")).toBe("once");
    expect(conversationEmptyState.querySelector("[aria-hidden='true']")?.textContent).toBe("Select or create a session.");
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
    stores.chatStore.load = vi.fn(async () => []);

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
    stores.chatStore.load = vi.fn(async () => []);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Search chats" }));

    const dialog = screen.getByRole("dialog", { name: "Chat search" });
    await user.click(within(dialog).getByRole("button", { name: /New Chat/ }));

    await waitFor(() => expect(stores.sessionStore.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Chat search" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New session" })).toBeTruthy();
  });

  it("uses a raised start layout for an empty active session", async () => {
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => []);

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

  it("cycles short empty-session suggestions with a type-delete motion hook", async () => {
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => []);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const start = await screen.findByLabelText("Start a new chat");
    const suggestions = within(start).getByLabelText("Prompt suggestions");
    const promptItems = suggestions.querySelectorAll(".react-prompt-cycle__item");

    expect(suggestions.getAttribute("data-motion")).toBe("text-type-loop");
    expect(promptItems).toHaveLength(4);
    expect(suggestions.textContent).toContain("帮我总结一份文档");
    expect(suggestions.textContent).toContain("帮我搜索资料并整理结论");
    expect(suggestions.textContent).toContain("帮我检查这段代码的问题");
    expect(suggestions.textContent).toContain("帮我把需求拆成可执行任务");
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
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u1");
    expect(within(userMessage).queryByRole("button", { name: /branch from here/i })).toBeNull();

    expect(within(screen.getByTestId("message-a1")).getByRole("button", { name: /branch from here/i })).toBeTruthy();
    expect(within(screen.getByTestId("message-a2")).queryByRole("button", { name: /branch from here/i })).toBeNull();
    expect(screen.getByRole("button", { name: /open details for shell/i })).toBeTruthy();
  });

  it("renders tool activity as collapsible agent steps", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const toolMessage = await screen.findByTestId("message-a2");
    const stepsToggle = within(toolMessage).getByRole("button", { name: /Agent steps, 1 step/i });
    expect(stepsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(toolMessage).getByRole("list", { name: "Agent steps" })).toBeTruthy();
    expect(within(toolMessage).getByRole("button", { name: "Open details for shell" })).toBeTruthy();
    expect(within(toolMessage).getByText("Done")).toBeTruthy();

    await user.click(stepsToggle);

    expect(stepsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(toolMessage).queryByRole("list", { name: "Agent steps" })).toBeNull();
  });

  it("marks the current running agent step in the stepper", async () => {
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
    stores.chatStore.load = vi.fn(async () => runningMessages);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-running");
    const stepper = message.querySelector(".react-agent-steps");
    const currentStep = message.querySelector(".react-agent-step-item[aria-current='step']") as HTMLElement | null;

    expect(stepper?.getAttribute("data-stepper")).toBe("true");
    expect(currentStep?.getAttribute("data-status")).toBe("active");
    expect(currentStep?.getAttribute("data-step-index")).toBe("0");
    expect(currentStep?.getAttribute("data-step-count")).toBe("3");
    expect(currentStep?.querySelector(".react-agent-step__status")?.textContent).toBe("running");
  });

  it("opens tool details in an animated right drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Open details for shell" }));

    const drawer = screen.getByLabelText("Details drawer");
    expect(drawer.getAttribute("data-motion")).toBe("fade-content");
    expect(drawer.getAttribute("data-state")).toBe("open");
    expect(drawer.textContent).toContain("Done");
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
    stores.chatStore.load = vi.fn(async () => markdownMessages);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Step" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(within(table).getByText("spawn_agent").tagName.toLowerCase()).toBe("strong");
    expect(screen.queryByText(/\| Step \| Status \|/)).toBeNull();
  });

  it("copies individual message text from message actions", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const assistantMessage = await screen.findByTestId("message-a1");
    await user.click(within(assistantMessage).getByRole("button", { name: "Copy message" }));

    expect(writeText).toHaveBeenCalledWith("Yes.");
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
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => (sessionId === "s2" ? branchMessages : sourceMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const assistantMessage = await screen.findByTestId("message-a1");
    await user.click(within(assistantMessage).getByRole("button", { name: "Branch from here" }));

    expect(stores.chatStore.branchFromMessage).toHaveBeenCalledWith("s1", "a1");
    expect(await screen.findByRole("heading", { name: "Branch from Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Branch from Yes" })).toBeTruthy();
    expect(screen.getByText("Branch loaded")).toBeTruthy();
  });

  it("sends composer text through the chat store", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const input = await screen.findByRole("textbox", { name: /message/i });
    await user.type(input, "Hello from React");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.chatStore.send).toHaveBeenCalledWith("s1", { text: "Hello from React", usePersistentRag: true });
    expect((input as HTMLTextAreaElement).value).toBe("");
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

    expect(stores.chatStore.send).toHaveBeenCalledWith("s1", {
      model: "deepseek-reasoner",
      text: "Use a specific model",
      usePersistentRag: true,
    });
  });

  it("keeps the old knowledge RAG toggle in the composer tools menu", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Tools" }));

    const ragToggle = screen.getByRole("menuitemcheckbox", { name: /Knowledge RAG/i });
    expect(ragToggle.getAttribute("aria-checked")).toBe("true");

    await user.click(ragToggle);
    await waitFor(() => {
      expect(screen.getByRole("menuitemcheckbox", { name: /Knowledge RAG/i }).getAttribute("aria-checked")).toBe("false");
    });

    await user.type(screen.getByRole("textbox", { name: /message/i }), "No retrieved material");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(stores.chatStore.send).toHaveBeenCalledWith("s1", {
      text: "No retrieved material",
      usePersistentRag: false,
    });
  });

  it("closes the composer tools menu when another composer area is clicked", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: "Planning notes" });
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Knowledge RAG/i })).toBeTruthy();

    await user.click(screen.getByRole("textbox", { name: /message/i }));

    expect(screen.queryByRole("menuitemcheckbox", { name: /Knowledge RAG/i })).toBeNull();
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

    expect(stores.chatStore.send).toHaveBeenCalledWith("s1", {
      text: `Summarize this\n\nPasted content:\n${pastedText}`,
      usePersistentRag: true,
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

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".react-text-type__text");
    expect(css).toContain("react-list-enter");
    expect(css).toContain("react-drawer-enter");
    expect(css).toContain("react-stepper-current");
    expect(css).toContain("react-prompt-type-delete");
    expect(css).toContain("react-session-dissolve");
    expect(css).toContain("react-session-particle-burst");
    expect(css).toContain(".react-session-row__particles");
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
