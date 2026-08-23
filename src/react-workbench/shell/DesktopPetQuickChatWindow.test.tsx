// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPetQuickChatRequest, DesktopPetQuickChatWindowClient } from "../../app-core/native/desktopNativePetQuickChat";
import { unavailableTinyOsEffectiveCapabilities } from "../../app-core/chat/tinyOsCapabilities";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStore, SessionStore, SettingsStore } from "../services";
import { timelineFromReactMessages } from "../chat/test/timelineFixtures";
import { DesktopPetQuickChatWindow } from "./DesktopPetQuickChatWindow";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("DesktopPetQuickChatWindow", () => {
  it("keeps the model menu and token usage operable in the compact composer", async () => {
    const sessionStore: SessionStore = {
      list: vi.fn(async () => [{
        id: "regular-1",
        model: "deepseek-v4-pro",
        modelProvider: "deepseek",
        title: "Regular",
        updatedAtMs: Date.now(),
      }]),
      create: vi.fn(async () => ({ id: "quick-1", title: "Quick", updatedAtMs: Date.now() })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    };
    const chatStore: ChatStore = {
      load: vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [{
        id: "assistant-1",
        role: "assistant",
        createdAtMs: Date.now(),
        text: "Done",
        status: "complete",
        usage: {
          contextWindowTokens: 128_000,
          contextWindowUsedTokens: 64_000,
          percent: 50,
        },
      }])),
      loadTinyOsCapabilities: vi.fn(async (sessionId) => unavailableTinyOsEffectiveCapabilities(
        sessionId,
        "test",
        "Unavailable in test",
      )),
      dispatch: vi.fn(async () => undefined),
      listAgentUiForms: vi.fn(async () => []),
      branchFromMessage: vi.fn(async () => ({ id: "branch", title: "Branch", updatedAtMs: Date.now() })),
      copyMarkdown: vi.fn(async () => ""),
      subscribe: vi.fn(() => () => undefined),
    };
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => [
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", providerId: "deepseek", default: true },
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", providerId: "deepseek" },
        { id: "deepseek-v4-lite", label: "DeepSeek V4 Lite", providerId: "deepseek" },
      ]),
    };
    const client: DesktopPetQuickChatWindowClient = {
      dismiss: vi.fn(async () => undefined),
      listen: vi.fn(async () => () => undefined),
      openInMain: vi.fn(async () => undefined),
      startDragging: vi.fn(async () => undefined),
    };
    const user = userEvent.setup();
    window.localStorage.setItem("tinybot.ui.chat.composer-model", "deepseek-v4-pro");
    render(<DesktopPetQuickChatWindow client={client} services={{ chatStore, sessionStore, settingsStore }} />);

    const recentSession = await screen.findByRole("button", { name: /Regular/ });
    await user.click(screen.getByRole("button", { name: "Select model" }));
    let menu = screen.getByRole("dialog", { name: "Model and reasoning effort" });
    await user.click(within(menu).getByRole("button", { name: /Model DeepSeek V4 Pro/ }));
    await user.click(screen.getByRole("option", { name: /DeepSeek V4 Flash/ }));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-v4-flash");

    await user.click(recentSession);
    const usage = await screen.findByLabelText("Context window 50% used, 50% left");
    expect(usage.textContent).toContain("64k / 128k tokens used");

    await user.click(screen.getByRole("button", { name: "Select model" }));
    menu = screen.getByRole("dialog", { name: "Model and reasoning effort" });
    await user.click(within(menu).getByRole("button", { name: /Model DeepSeek V4 Pro/ }));
    await user.click(screen.getByRole("option", { name: /DeepSeek V4 Lite/ }));

    expect(screen.getByRole("button", { name: "Select model" }).textContent).toContain("DeepSeek V4 Lite");
    expect(sessionStore.setModel).toHaveBeenCalledWith("regular-1", "deepseek-v4-lite", "deepseek");
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-v4-flash");

    const header = screen.getByRole("banner");
    const openInMain = screen.getByRole("button", { name: "Open in Tinybot" });
    fireEvent.pointerDown(header, { button: 0 });
    fireEvent.pointerDown(openInMain, { button: 0 });
    await user.click(openInMain);

    expect(client.startDragging).toHaveBeenCalledTimes(1);
    expect(client.openInMain).toHaveBeenCalledWith("regular-1");
  });

  it("does not clip composer popovers inside the quick-chat toolbar", () => {
    const css = readFileSync("src/react-workbench/shell/DesktopPetQuickChatWindow.css", "utf8");

    expect(css).toMatch(/\.react-desktop-pet-quick-chat__composer \.claude-ai-input__tools\s*{[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.react-desktop-pet-quick-chat__composer \.claude-ai-input__model-menu\s*{[^}]*left:\s*-12px;/s);
  });

  it("grants the native window operations required by main handoff and quick-chat dragging", () => {
    const mainCapability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as {
      permissions: string[];
    };
    const quickChatCapability = JSON.parse(readFileSync("src-tauri/capabilities/desktop-pet-chat.json", "utf8")) as {
      permissions: string[];
    };

    expect(mainCapability.permissions).toContain("core:window:allow-set-focus");
    expect(mainCapability.permissions).toContain("core:window:allow-unminimize");
    expect(quickChatCapability.permissions).toContain("core:window:allow-start-dragging");
  });

  it("places dropped text in the composer and creates a General chat on first send", async () => {
    let requestListener: ((request: DesktopPetQuickChatRequest) => void) | undefined;
    const client: DesktopPetQuickChatWindowClient = {
      dismiss: vi.fn(async () => undefined),
      listen: vi.fn(async (listener) => {
        requestListener = listener;
        return () => undefined;
      }),
      openInMain: vi.fn(async () => undefined),
      startDragging: vi.fn(async () => undefined),
    };
    const sessionStore: SessionStore = {
      list: vi.fn(async () => [
        { id: "regular-1", title: "Regular", updatedAtMs: Date.now() },
        { id: "workspace-1", title: "Workspace", updatedAtMs: Date.now(), workingDirectory: "D:\\repo" },
      ]),
      create: vi.fn(async () => ({
        id: "quick-1",
        title: "Selected browser text and a question",
        updatedAtMs: Date.now(),
      })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    };
    const chatStore: ChatStore = {
      load: vi.fn(async (sessionId: string): Promise<ChatTimelineSnapshot> => ({
        schemaVersion: "tinybot.chat_timeline.v1",
        sessionId,
        source: "canonical",
        turnRevisions: {},
        turns: [],
        diagnostics: [],
      })),
      loadTinyOsCapabilities: vi.fn(async (sessionId) => unavailableTinyOsEffectiveCapabilities(
        sessionId,
        "test",
        "Unavailable in test",
      )),
      dispatch: vi.fn(async () => undefined),
      listAgentUiForms: vi.fn(async () => []),
      branchFromMessage: vi.fn(async () => ({ id: "branch", title: "Branch", updatedAtMs: Date.now() })),
      copyMarkdown: vi.fn(async () => ""),
      subscribe: vi.fn(() => () => undefined),
    };
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadChatModels: vi.fn(async () => []),
    };
    const user = userEvent.setup();
    render(
      <DesktopPetQuickChatWindow
        client={client}
        services={{ chatStore, sessionStore, settingsStore }}
      />,
    );
    await waitFor(() => expect(requestListener).toBeTypeOf("function"));

    act(() => requestListener?.({
      schemaVersion: "tinybot.desktop_pet_quick_chat.v2",
      requestId: "drop-1",
      draft: "Selected browser text",
      attachments: [{
        contentHash: "abc123",
        mimeType: "image/png",
        name: "diagram.png",
        path: "C:\\Tinybot\\diagram.png",
        sizeBytes: 2048,
      }],
    }));

    const composer = await screen.findByRole("textbox", { name: "Message" });
    expect((composer as HTMLTextAreaElement).value).toBe("Selected browser text");
    expect(screen.getByText("diagram.png")).toBeTruthy();
    expect(screen.getByText("Regular")).toBeTruthy();
    expect(screen.queryByText("Workspace")).toBeNull();
    fireEvent.change(composer, { target: { value: "Selected browser text and a question" } });
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sessionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      entryPoint: "desktop-pet",
      title: "Selected browser text and a …",
    })));
    expect(chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "turn.submit",
      source: { control: "desktop-pet-quick-chat", surface: "chat" },
      target: { sessionId: "quick-1" },
      input: expect.objectContaining({
        references: [expect.objectContaining({
          contentHash: "abc123",
          rawPath: "C:\\Tinybot\\diagram.png",
          type: "tinyos.image",
        })],
        text: "Selected browser text and a question",
      }),
    }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    await waitFor(() => expect(screen.queryByText("diagram.png")).toBeNull());
  });
});
