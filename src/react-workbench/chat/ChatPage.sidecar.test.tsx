// @vitest-environment happy-dom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NativeTerminalRuntimeApi } from "../../app-core/native/desktopNativeTerminal";
import type { ChatEvent } from "../services";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  sidecarBrowserRuntime,
  sidecarBrowserSnapshot,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
  it("keeps the native browser obscured until the details drawer exits", async () => {
    const user = userEvent.setup();
    const browserRuntime = sidecarBrowserRuntime();
    const stores = createStores({ browserRuntime });
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);
    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    await user.click(within(screen.getByLabelText("Sidecar")).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Browser/ }));
    await waitFor(() => expect(document.querySelector(".react-sidecar-browser-surface")?.getAttribute("data-live")).toBe("true"));
    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for shell" }));
    const drawer = screen.getByLabelText("Details drawer");
    let finish!: () => void;
    const animation = {
      transitionProperty: "opacity",
      playState: "running",
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    Object.defineProperty(drawer, "getAnimations", { value: () => [animation] });
    await user.click(within(drawer).getByRole("button", { name: "Close details drawer" }));
    expect(drawer.dataset.state).toBe("closing");
    expect(document.querySelector(".react-sidecar-browser-surface")?.getAttribute("data-live")).toBeNull();
    await waitFor(() => expect(browserRuntime.updateSurface).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false })));
    await act(async () => { animation.playState = "finished"; finish(); });
    expect(document.querySelector(".react-sidecar-browser-surface")?.getAttribute("data-live")).toBe("true");
    expect(browserRuntime.closeSession).not.toHaveBeenCalled();
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
    const workspace = document.querySelector<HTMLElement>(".react-chat-workspace");
    within(sidecar).getByRole("separator").focus();
    await user.keyboard("{ArrowLeft}");
    expect(workspace?.dataset.sidecarLayoutMotion).toBe("instant");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    const menu = within(sidecar).getByRole("menu", { name: "Choose a resource" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).queryByText("Artifacts")).toBeNull();

    const terminal = within(menu).getByRole("menuitem", { name: /Terminal/ });
    await waitFor(() => expect(terminal.hasAttribute("disabled")).toBe(false));
    await user.click(terminal);
    await user.click(within(sidecar).getByRole("menuitem", { name: "PowerShell" }));
    expect(within(sidecar).getByRole("tab", { name: "PowerShell" })).toBeTruthy();

    await user.click(within(sidecar).getByRole("button", { name: "Hide Sidecar" }));
    expect(screen.queryByLabelText("Sidecar")).toBeNull();
    expect(document.querySelector<HTMLElement>(".react-sidecar")?.dataset.hidden).toBe("true");

    await user.click(screen.getByRole("button", { name: "Show Sidecar" }));
    expect(workspace?.dataset.sidecarLayoutMotion).toBe("animated");
    expect(within(screen.getByLabelText("Sidecar")).getByRole("tab", { name: "PowerShell" })).toBeTruthy();
  });

  it("allows a regular chat to create a Terminal in the native default workspace", async () => {
    const user = userEvent.setup();
    const stores = createStores();

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    const sidecar = screen.getByLabelText("Sidecar");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    const terminal = within(sidecar).getByRole("menuitem", { name: /Terminal/ });

    expect(terminal.hasAttribute("disabled")).toBe(false);
    await user.click(terminal);
    await user.click(within(sidecar).getByRole("menuitem", { name: "PowerShell" }));
    expect(within(sidecar).getByRole("tab", { name: "PowerShell" })).toBeTruthy();
  });

  it("terminates a user terminal only when its Sidecar resource is closed", async () => {
    const user = userEvent.setup();
    const terminalRuntime = {
      create: vi.fn(),
      poll: vi.fn(),
      resize: vi.fn(),
      terminate: vi.fn(async () => undefined),
      write: vi.fn(),
    } as unknown as NativeTerminalRuntimeApi;
    const stores = createStores({
      terminalRuntime,
      sessions: [{
        chatId: "chat-1",
        id: "s1",
        status: "idle",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        workingDirectory: "D:/code/tinybot",
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    const sidecar = screen.getByLabelText("Sidecar");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(within(sidecar).getByRole("menuitem", { name: /Terminal/ }));
    await user.click(within(sidecar).getByRole("menuitem", { name: "Command Prompt" }));

    await user.click(within(sidecar).getByRole("button", { name: "Hide Sidecar" }));
    expect(terminalRuntime.terminate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Show Sidecar" }));
    await user.click(within(screen.getByLabelText("Sidecar")).getByRole("button", { name: "Close Command Prompt tab" }));

    await waitFor(() => expect(terminalRuntime.terminate).toHaveBeenCalledWith("terminal:D%3A%2Fcode%2Ftinybot:1"));
    expect(within(screen.getByLabelText("Sidecar")).queryByRole("tab", { name: "Command Prompt" })).toBeNull();
  });

  it("provisions and releases the shared native WebView2 session from a Browser resource", async () => {
    const user = userEvent.setup();
    const browserRuntime = sidecarBrowserRuntime();
    const stores = createStores({
      browserRuntime,
      sessions: [{
        chatId: "chat-1",
        id: "s1",
        status: "idle",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        workingDirectory: "D:/code/tinybot",
      }],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    await user.click(within(screen.getByLabelText("Sidecar")).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Browser/ }));

    await waitFor(() => expect(browserRuntime.createSession).toHaveBeenCalledWith({ ownerSessionId: "s1" }));
    const sidecar = screen.getByLabelText("Sidecar");
    expect(await within(sidecar).findByRole("tab", { name: "Example" })).toBeTruthy();
    expect(within(sidecar).getByRole("textbox", { name: "Browser address" })).toBeTruthy();

    await user.click(within(sidecar).getByRole("button", { name: "Close Example tab" }));
    await waitFor(() => expect(browserRuntime.closeSession).toHaveBeenCalledWith("browser-session-1"));
    expect(within(sidecar).queryByRole("tab", { name: "Example" })).toBeNull();
  });

  it("reattaches a retained Browser snapshot when returning to its Thread", async () => {
    const user = userEvent.setup();
    const browserRuntime = sidecarBrowserRuntime();
    const stores = createStores({
      browserRuntime,
      sessions: [
        {
          chatId: "chat-1",
          id: "s1",
          status: "idle",
          title: "Planning notes",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
          workingDirectory: "D:/code/tinybot",
        },
        {
          chatId: "chat-2",
          id: "s2",
          status: "idle",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 6, 4, 11, 50, 0),
          workingDirectory: "D:/code/tinybot",
        },
      ],
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    await user.click(within(screen.getByLabelText("Sidecar")).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Browser/ }));
    expect(await within(screen.getByLabelText("Sidecar")).findByRole("textbox", { name: "Browser address" })).toBeTruthy();

    const sidebar = screen.getByLabelText("Sessions");
    await user.click(within(sidebar).getByRole("button", { name: "Knowledge review" }));
    await screen.findByRole("heading", { name: "Knowledge review" });
    await user.click(within(sidebar).getByRole("button", { name: "Planning notes" }));

    await waitFor(() => expect(browserRuntime.snapshot).toHaveBeenCalledWith("browser-session-1"));
    expect(await within(screen.getByLabelText("Sidecar")).findByRole("textbox", { name: "Browser address" })).toBeTruthy();
    expect(browserRuntime.createSession).toHaveBeenCalledTimes(1);
    expect(browserRuntime.createTab).not.toHaveBeenCalled();
  });

  it("does not create a second native tab when the Creating event binds the new resource first", async () => {
    const user = userEvent.setup();
    const creatingSnapshot = sidecarBrowserSnapshot("native-tab-1", false, 1, "creating");
    const readySnapshot = sidecarBrowserSnapshot("native-tab-1", false, 2);
    const twoTabSnapshot = sidecarBrowserSnapshot("native-tab-2", true, 3);
    const browserRuntime = sidecarBrowserRuntime(readySnapshot);
    let resolveCreation: (snapshot: typeof readySnapshot) => void = () => undefined;
    const creation = new Promise<typeof readySnapshot>((resolve) => {
      resolveCreation = resolve;
    });
    vi.mocked(browserRuntime.createSession).mockReturnValue(creation);
    vi.mocked(browserRuntime.createTab).mockResolvedValue(twoTabSnapshot);
    let browserListener: ((event: ChatEvent) => void) | undefined;
    const stores = createStores({ browserRuntime });
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      browserListener = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    const sidecar = screen.getByLabelText("Sidecar");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Browser/ }));
    await waitFor(() => expect(browserRuntime.createSession).toHaveBeenCalledOnce());
    act(() => browserListener?.({ browserSnapshot: creatingSnapshot, type: "browser.snapshot" }));
    await waitFor(() => expect(within(sidecar).getAllByRole("tab")).toHaveLength(1));

    await act(async () => {
      resolveCreation(readySnapshot);
      await creation;
    });

    await waitFor(() => expect(browserRuntime.createTab).not.toHaveBeenCalled());
    expect(within(sidecar).getAllByRole("tab")).toHaveLength(1);
  });

  it("does not bounce or repeat native activation while stale Browser snapshots settle", async () => {
    const user = userEvent.setup();
    const initialSnapshot = sidecarBrowserSnapshot("native-tab-1", true);
    const settledSnapshot = sidecarBrowserSnapshot("native-tab-2", true, 4);
    const browserRuntime = sidecarBrowserRuntime(initialSnapshot);
    let resolveActivation: (snapshot: typeof settledSnapshot) => void = () => undefined;
    const activation = new Promise<typeof settledSnapshot>((resolve) => {
      resolveActivation = resolve;
    });
    vi.mocked(browserRuntime.activateTab).mockReturnValue(activation);
    let browserListener: ((event: ChatEvent) => void) | undefined;
    const stores = createStores({
      browserRuntime,
      sessions: [{
        chatId: "chat-1",
        id: "s1",
        status: "idle",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        workingDirectory: "D:/code/tinybot",
      }],
    });
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      browserListener = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Show Sidecar" }));
    const sidecar = screen.getByLabelText("Sidecar");
    await user.click(within(sidecar).getAllByRole("button", { name: "New Sidecar tab" })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Browser/ }));
    await user.click(await within(sidecar).findByRole("tab", { name: "Second" }));
    await waitFor(() => expect(browserRuntime.activateTab).toHaveBeenCalledTimes(1));

    act(() => browserListener?.({
      browserSnapshot: sidecarBrowserSnapshot("native-tab-1", true, 2),
      type: "browser.snapshot",
    }));
    await waitFor(() => expect(
      within(sidecar).getByRole("tab", { name: "Second" }).getAttribute("aria-selected"),
    ).toBe("true"));
    act(() => browserListener?.({
      browserSnapshot: sidecarBrowserSnapshot("native-tab-1", true, 3),
      type: "browser.snapshot",
    }));

    expect(browserRuntime.activateTab).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveActivation(settledSnapshot);
      await activation;
    });
    await waitFor(() => expect(
      within(sidecar).getByRole("tab", { name: "Second" }).getAttribute("aria-selected"),
    ).toBe("true"));
    expect(browserRuntime.activateTab).toHaveBeenCalledTimes(1);
  });
});
