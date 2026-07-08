// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopShell } from "./DesktopShell";
import { buildAgentDefaultsSettings } from "../../app-core/settings/agentDefaultsSettings";
import { buildProviderModelsSettings } from "../../app-core/settings/providerModelsSettings";
import type { AppServices, SessionSummary } from "../services";
import type { ReactChatMessage } from "../chat/messageActions";

afterEach(() => cleanup());

function createServices(options: { messages?: ReactChatMessage[]; sessions?: SessionSummary[] } = {}): AppServices & {
  workspaceStore: { listFiles: ReturnType<typeof vi.fn> };
  knowledgeStore: { listDocuments: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn> };
  toolsStore: { listSkills: ReturnType<typeof vi.fn> };
  settingsStore: {
    load: ReturnType<typeof vi.fn>;
    loadAgentDefaultsSettings?: ReturnType<typeof vi.fn>;
    saveAgentDefaultsSettings?: ReturnType<typeof vi.fn>;
    loadProviderSettings?: ReturnType<typeof vi.fn>;
    saveProviderSettings?: ReturnType<typeof vi.fn>;
  };
} {
  return {
    sessionStore: {
      list: vi.fn(async () => options.sessions ?? []),
      create: vi.fn(async () => ({ id: "s1", chatId: "chat-1", title: "New session", updatedAtMs: Date.now() })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    },
    chatStore: {
      load: vi.fn(async () => options.messages ?? []),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      resolveApproval: vi.fn(async () => undefined),
      listAgentUiForms: vi.fn(async () => []),
      submitAgentUiForm: vi.fn(async () => undefined),
      cancelAgentUiForm: vi.fn(async () => undefined),
      branchFromMessage: vi.fn(async () => ({ id: "s1", chatId: "chat-1", title: "Branch", updatedAtMs: Date.now() })),
      copyMarkdown: vi.fn(async () => ""),
      subscribe: vi.fn(() => () => undefined),
    },
    workspaceStore: {
      listFiles: vi.fn(async () => [
        { path: "src/main.ts", size: 512 },
        { path: "docs/notes.md", size: 2048 },
      ]),
    },
    knowledgeStore: {
      listDocuments: vi.fn(async () => [
        { id: "doc-1", title: "Project Plan", source: "docs/plan.md" },
      ]),
      stats: vi.fn(async () => [{ label: "Documents", value: "1" }]),
    },
    toolsStore: {
      listSkills: vi.fn(async () => [
        { name: "review-code", description: "Review current changes" },
      ]),
    },
    settingsStore: {
      load: vi.fn(async () => [{ label: "Default model", value: "tinybot" }]),
    },
  };
}

describe("DesktopShell", () => {
  it("keeps the React window frame draggable and top menus compact", () => {
    const controls = {
      close: vi.fn(async () => undefined),
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
    };
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} windowControls={controls} />);

    const frame = document.querySelector(".react-window-frame");
    expect(frame?.getAttribute("data-tauri-drag-region")).toBe("");

    const appMenuButton = screen.getByRole("button", { name: "App" });
    expect(appMenuButton.querySelector(".react-top-menu__icon")).toBeTruthy();
    expect(appMenuButton.querySelector(".react-top-menu__label")?.textContent).toBe("App");

    fireEvent.pointerDown(appMenuButton);

    fireEvent.doubleClick(frame as Element);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(appMenuButton);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("renders working custom window control buttons", async () => {
    const user = userEvent.setup();
    const controls = {
      close: vi.fn(async () => undefined),
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
    };
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} windowControls={controls} />);

    await user.click(screen.getByRole("button", { name: "Minimize window" }));
    await user.click(screen.getByRole("button", { name: "Maximize window" }));
    await user.click(screen.getByRole("button", { name: "Close window" }));

    expect(controls.minimize).toHaveBeenCalledTimes(1);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(controls.close).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(screen.getByRole("group", { name: "Window controls" }));
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("keeps shell navigation typography compact", () => {
    const css = readFileSync("src/react-workbench/styles/workbench.css", "utf8");

    expect(css).toMatch(/\.react-window-frame__brand\s*{[^}]*font-size:\s*13px;/s);
    expect(css).toMatch(/\.react-top-menu__trigger\s*{[^}]*font-size:\s*12px;/s);
    expect(css).toMatch(/\.react-top-menu__menu-item\s*{[^}]*font-size:\s*13px;/s);
    expect(css).toMatch(/\.react-activity-rail button\s*{[^}]*font-size:\s*10px;/s);
    expect(css).toMatch(/\.react-workbench-layout\s*{[^}]*grid-template-columns:\s*58px minmax\(0,\s*1fr\);/s);
    expect(css).toMatch(/\.react-activity-rail button span\s*{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.react-activity-rail button::after\s*{[^}]*content:\s*attr\(data-label\);/s);
    expect(css).toMatch(/\.react-session-list\s*{[^}]*transition:\s*width 260ms var\(--motion-ease-standard\);/s);
    expect(css).toMatch(/\.react-session-list\[data-collapsed="true"\]\s*{[^}]*width:\s*64px;/s);
    expect(css).toMatch(/\.react-session-list__new\s*{[^}]*font-size:\s*12px;/s);
    expect(css).toMatch(/\.react-session-row__title\s*{[^}]*font-size:\s*12px;/s);
    expect(css).toMatch(/\.react-default-llm-panel__controls\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(220px,\s*1fr\)\) 180px;/s);
    expect(css).toMatch(/\.react-default-llm-panel__controls > button\s*{[^}]*align-self:\s*end;/s);
    expect(css).toMatch(/\.react-settings-choice-item \.react-top-menu__menu-label\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) max-content;/s);
  });

  it("opens legacy top menu command lists from the React window frame", async () => {
    const user = userEvent.setup();
    const services = createServices();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await user.click(screen.getByRole("button", { name: "App" }));
    const appMenu = screen.getByRole("menu", { name: "Application menu" });
    for (const item of ["New Chat", "Search Sessions", "Stop Generation", "Toggle Theme", "Toggle Sidebar"]) {
      expect(within(appMenu).getByRole("menuitem", { name: new RegExp(item) })).toBeTruthy();
    }
    expect(within(appMenu).queryByRole("menuitem", { name: /Command Palette/ })).toBeNull();
    expect(within(appMenu).getAllByRole("separator")).toHaveLength(2);
    expect(within(appMenu).getByText("Ctrl+N").classList.contains("react-top-menu__shortcut")).toBe(true);

    await user.click(within(appMenu).getByRole("menuitem", { name: /New Chat/ }));
    await waitFor(() => expect(services.sessionStore.create).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Resources" }));
    const resourcesMenu = screen.getByRole("menu", { name: "Resources menu" });
    expect(within(resourcesMenu).getByRole("menuitem", { name: "Chat" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "System" }));
    const systemMenu = screen.getByRole("menu", { name: "System menu" });
    expect(within(systemMenu).getByRole("menuitem", { name: "Settings (Ctrl+,)" })).toBeTruthy();
    expect(within(systemMenu).getByRole("menuitem", { name: "Gateway Status (Ctrl+Shift+G)" })).toBeTruthy();

    await user.click(within(systemMenu).getByRole("menuitem", { name: "Settings (Ctrl+,)" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Help" }));
    const helpMenu = screen.getByRole("menu", { name: "Help menu" });
    expect(within(helpMenu).getByRole("menuitem", { name: "Documentation (F1)" })).toBeTruthy();
    const moreHelp = within(helpMenu).getByRole("menuitem", { name: "More" });
    expect(moreHelp.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(moreHelp);
    const moreHelpMenu = screen.getByRole("menu", { name: "More help options" });
    for (const item of ["Shortcut Help", "Page Help", "Backend Logs", "Open native workbench", "Tinybot repo"]) {
      expect(within(moreHelpMenu).getByRole("menuitem", { name: new RegExp(item) })).toBeTruthy();
    }
  });

  it("routes session search recommendations through the shell", async () => {
    const user = userEvent.setup();
    const services = createServices();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await user.click(await screen.findByRole("button", { name: "Search chats" }));
    const dialog = screen.getByRole("dialog", { name: "Chat search" });
    await user.click(within(dialog).getByRole("button", { name: /Open folder/ }));

    expect(screen.queryByRole("dialog", { name: "Chat search" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Workspace Files" })).toBeTruthy();
  });

  it("closes an open top menu when clicking outside it", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    await user.click(screen.getByRole("button", { name: "App" }));
    const appMenu = screen.getByRole("menu", { name: "Application menu" });

    fireEvent.pointerDown(appMenu);
    expect(screen.getByRole("menu", { name: "Application menu" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.queryByRole("menu", { name: "Application menu" })).toBeNull();
  });

  it("renders native-style top menus and functional secondary pages", async () => {
    const user = userEvent.setup();
    const services = createServices();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    for (const menu of ["App", "Resources", "System", "Help"]) {
      expect(screen.getByRole("button", { name: menu })).toBeTruthy();
    }

    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByRole("heading", { name: "Workspace Files" })).toBeTruthy();
    expect(screen.getByText("src/main.ts")).toBeTruthy();
    expect(services.workspaceStore.listFiles).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(await screen.findByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByText("Project Plan")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(await screen.findByRole("heading", { name: "Tools & Skills" })).toBeTruthy();
    expect(screen.getByText("review-code")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Default model")).toBeTruthy();

    expect(screen.queryByText(/placeholder/i)).toBeNull();
    expect(screen.queryByText(/Vue/i)).toBeNull();
  });

  it("renders provider preset cards and saves provider configuration from Settings", async () => {
    const user = userEvent.setup();
    const initialProviderConfig = {
      revision: "hash:1",
      agents: { defaults: { activeProfile: "deepseek-default", model: "deepseek-v4-pro" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            enabled: true,
            apiKeyConfigured: true,
            models: ["deepseek-v4-pro"],
            defaultModel: "deepseek-v4-pro",
          },
          "openai-default": {
            provider: "openai",
            enabled: true,
            apiKeyConfigured: true,
            models: ["gpt-4.1"],
            defaultModel: "gpt-4.1",
          },
        },
      },
    };
    const savedProviderConfig = {
      revision: "hash:2",
      agents: { defaults: { activeProfile: "openai-default", model: "deepseek-v4-pro" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            enabled: true,
            apiKeyConfigured: true,
            models: ["deepseek-v4-pro"],
          },
          "openai-default": {
            provider: "openai",
            enabled: true,
            apiBase: "https://api.openai.com/v1",
            apiKeyConfigured: true,
          },
        },
      },
    };
    const saveProviderSettings = vi.fn(async (_currentConfig: unknown, _patch: unknown) => buildProviderModelsSettings(savedProviderConfig));
    const fetchProviderModels = vi.fn(async () => ({
      ok: true,
      models: ["deepseek-v4-pro", "deepseek-live"],
      warning: null,
      url: "https://api.deepseek.com/models",
    }));
    const services = createServices();
    services.settingsStore.loadProviderSettings = vi.fn(async () => buildProviderModelsSettings(initialProviderConfig));
    services.settingsStore.saveProviderSettings = saveProviderSettings;
    services.settingsStore.fetchProviderModels = fetchProviderModels;
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Provider & Models" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings categories" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Provider & Models" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("region", { name: "Provider & Models" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Default LLM" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Provider: DeepSeek" }));
    const providerMenu = screen.getByRole("menu", { name: "Provider options" });
    expect(providerMenu.classList.contains("react-settings-choice-popover")).toBe(true);
    expect(providerMenu.classList.contains("react-top-menu__popover")).toBe(true);
    await user.click(within(providerMenu).getByRole("menuitemradio", { name: /OpenAI/ }));
    expect(screen.queryByRole("menu", { name: "Provider options" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Model: gpt-4.1" }));
    const modelMenu = screen.getByRole("menu", { name: "Model options" });
    expect(modelMenu.classList.contains("react-settings-choice-popover")).toBe(true);
    await user.click(within(modelMenu).getByRole("menuitemradio", { name: /gpt-4.1/ }));
    await user.click(screen.getByRole("button", { name: "Save default LLM" }));

    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1));
    expect(saveProviderSettings.mock.calls[0][1]).toEqual({
      agents: { defaults: { activeProfile: "openai-default", model: "gpt-4.1" } },
    });

    expect(screen.getByRole("article", { name: "DeepSeek provider" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "DashScope provider" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "OpenAI provider" })).toBeTruthy();
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Manage DeepSeek models" }));
    const modelsDialog = screen.getByRole("dialog", { name: "DeepSeek models" });
    expect(modelsDialog).toBeTruthy();
    expect(within(modelsDialog).getAllByText("deepseek-v4-pro").length).toBeGreaterThan(0);
    await user.click(within(modelsDialog).getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith({
      providerId: "deepseek",
      profileId: "deepseek-default",
      apiBase: "https://api.deepseek.com",
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    }));
    await waitFor(() => expect(within(modelsDialog).getAllByText("deepseek-live").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Close models" }));

    await user.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    const dialog = screen.getByRole("dialog", { name: "Configure OpenAI" });
    expect((within(dialog).getByLabelText("API base") as HTMLInputElement).value).toBe("https://api.openai.com/v1");
    await user.type(within(dialog).getByLabelText("API key"), "sk-test");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(2));
    expect(saveProviderSettings.mock.calls[1][1]).toEqual({
      providers: {
        profiles: {
          "openai-default": {
            provider: "openai",
            displayName: "OpenAI",
            enabled: true,
            apiBase: "https://api.openai.com/v1",
            apiKey: "sk-test",
          },
        },
      },
    });
  });

  it("renders Agent Defaults settings and jumps back to Provider & Models", async () => {
    const user = userEvent.setup();
    const initialConfig = {
      revision: "hash:1",
      agents: {
        defaults: {
          activeProfile: "deepseek-default",
          model: "deepseek-v4-pro",
          timezone: "Asia/Singapore",
          temperature: 0.3,
          maxTokens: 4096,
          contextWindowTokens: 128000,
          contextWindowStrategy: "discard",
          maxToolIterations: 12,
          reasoningEffort: "medium",
        },
      },
    };
    const savedConfig = {
      revision: "hash:2",
      agents: {
        defaults: {
          ...initialConfig.agents.defaults,
          temperature: 0.6,
          maxTokens: 2048,
        },
      },
    };
    const services = createServices();
    const saveAgentDefaultsSettings = vi.fn(async (_currentConfig: unknown, _patch: unknown) => buildAgentDefaultsSettings(savedConfig));
    services.settingsStore.loadProviderSettings = vi.fn(async () => buildProviderModelsSettings(initialConfig));
    services.settingsStore.saveProviderSettings = vi.fn(async (_currentConfig: unknown, _patch: unknown) => buildProviderModelsSettings(initialConfig));
    services.settingsStore.loadAgentDefaultsSettings = vi.fn(async () => buildAgentDefaultsSettings(initialConfig));
    services.settingsStore.saveAgentDefaultsSettings = saveAgentDefaultsSettings;
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Agent Defaults" }));

    expect(await screen.findByRole("heading", { name: "Agent Defaults" })).toBeTruthy();
    expect(screen.getByText("deepseek-default")).toBeTruthy();
    expect(screen.getByText("deepseek-v4-pro")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change default model in Provider & Models" }));
    expect(await screen.findByRole("heading", { name: "Provider & Models" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Agent Defaults" }));
    await user.clear(await screen.findByLabelText("Temperature"));
    await user.type(screen.getByLabelText("Temperature"), "0.6");
    await user.clear(screen.getByLabelText("Max output tokens"));
    await user.type(screen.getByLabelText("Max output tokens"), "2048");
    await user.click(screen.getByRole("button", { name: "Context window strategy: Discard old messages" }));
    const strategyMenu = screen.getByRole("menu", { name: "Context window strategy options" });
    expect(strategyMenu.classList.contains("react-settings-choice-popover")).toBe(true);
    expect(screen.getByRole("button", { name: "Reasoning effort: Medium" }).classList.contains("react-settings-choice-trigger")).toBe(true);
    await user.click(within(strategyMenu).getByRole("menuitemradio", { name: /Compact old messages/ }));
    await user.click(screen.getByRole("button", { name: "Save agent defaults" }));

    await waitFor(() => expect(saveAgentDefaultsSettings).toHaveBeenCalledTimes(1));
    expect(saveAgentDefaultsSettings.mock.calls[0][1]).toEqual({
      agents: {
        defaults: {
          timezone: "Asia/Singapore",
          temperature: 0.6,
          maxTokens: 2048,
          contextWindowTokens: 128000,
          contextWindowStrategy: "compact",
          maxIterations: 12,
          reasoningEffort: "medium",
        },
      },
    });
  });

  it("does not reserve Ctrl+K for a command palette", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("toggles the chat session sidebar from the keyboard and App menu", async () => {
    const user = userEvent.setup();
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={createServices()} />);

    const sidebar = await screen.findByLabelText("Sessions");
    expect(sidebar.getAttribute("data-collapsed")).toBe("false");

    await user.keyboard("{Control>}b{/Control}");

    expect(sidebar.getAttribute("data-collapsed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "App" }));
    await user.click(within(screen.getByRole("menu", { name: "Application menu" })).getByRole("menuitem", { name: /Toggle Sidebar/ }));

    expect(sidebar.getAttribute("data-collapsed")).toBe("false");
  });

  it("runs Stop Generation from the App menu for the active running chat", async () => {
    const user = userEvent.setup();
    const services = createServices({
      messages: [{
        id: "u1",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Keep going",
        status: "complete",
      }],
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Running chat",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "running",
      }],
    });
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    await screen.findByRole("heading", { name: "Running chat" });
    await user.click(screen.getByRole("button", { name: "App" }));
    const stopCommand = within(screen.getByRole("menu", { name: "Application menu" })).getByRole("menuitem", { name: /Stop Generation/ });

    expect((stopCommand as HTMLButtonElement).disabled).toBe(false);
    await user.click(stopCommand);

    expect(services.chatStore.stop).toHaveBeenCalledWith("s1");
  });

  it("runs Stop Generation from the keyboard shortcut for the active running chat", async () => {
    const services = createServices({
      messages: [{
        id: "u1",
        role: "user",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Keep going",
        status: "complete",
      }],
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Running chat",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        status: "running",
      }],
    });
    render(<DesktopShell now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} services={services} />);

    const stopButton = await screen.findByRole("button", { name: "Stop generation" });
    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(window, { ctrlKey: true, key: "." });

    expect(services.chatStore.stop).toHaveBeenCalledWith("s1");
  });

});
