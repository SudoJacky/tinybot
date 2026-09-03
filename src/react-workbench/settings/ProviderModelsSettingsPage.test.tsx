// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  readDefaultChatModelPreference,
  writeDefaultChatModel,
} from "../../app-core/chat/chatModelPreference";
import {
  buildProviderModelsSettings,
} from "../../app-core/settings/providerModelsSettings";
import type { SettingsStore } from "../services";
import { ProviderModelsSettingsPage } from "./ProviderModelsSettingsPage";

const currentConfig = {
  agents: {
    defaults: {
      activeProfile: "deepseek-default",
      model: "deepseek-v4-pro",
    },
  },
  providers: {
    profiles: {
      "deepseek-default": {
        provider: "deepseek",
        enabled: true,
        apiKeyConfigured: true,
        models: ["deepseek-v4-pro"],
        enabledModels: ["deepseek-v4-pro"],
        defaultModel: "deepseek-v4-pro",
      },
      "zai-default": {
        provider: "zai",
        enabled: true,
        apiKeyConfigured: true,
        models: ["glm-5.3-flash"],
        enabledModels: ["glm-5.3-flash"],
        defaultModel: "glm-5.3-flash",
      },
    },
  },
};

const zaiConfig = {
  ...currentConfig,
  agents: {
    defaults: {
      activeProfile: "zai-default",
      model: "glm-5.3-flash",
    },
  },
};

beforeEach(() => {
  window.localStorage.clear();
  writeDefaultChatModel("deepseek-v4-pro", "deepseek");
});

afterEach(() => cleanup());

describe("ProviderModelsSettingsPage", () => {
  test("saves a dedicated Memory model while defaulting to the global selection", async () => {
    const user = userEvent.setup();
    const saveProviderSettings = vi.fn(async (_config: unknown, _patch: unknown) => (
      buildProviderModelsSettings({
        ...currentConfig,
        memory: { activeProfile: "zai-default", model: "glm-5.3-flash" },
      })
    ));
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadProviderSettings: vi.fn(async () => buildProviderModelsSettings(currentConfig)),
      saveProviderSettings,
    };

    render(<ProviderModelsSettingsPage settingsStore={settingsStore} />);

    const memoryPanel = (await screen.findByRole("heading", { name: "Memory model" })).closest("section");
    expect(memoryPanel).toBeTruthy();
    const memory = within(memoryPanel!);
    expect(memory.getByRole("option", { name: "Follow global default — deepseek-v4-pro · DeepSeek" })).toBeTruthy();
    await user.selectOptions(
      memory.getByRole("combobox", { name: "Model used for Memory" }),
      memory.getByRole("option", { name: "glm-5.3-flash" }),
    );
    await user.click(memory.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledWith(currentConfig, {
      memory: {
        activeProfile: "zai-default",
        model: "glm-5.3-flash",
      },
    }));
  });

  test("can restore the Memory model to follow the global default", async () => {
    const user = userEvent.setup();
    const overrideConfig = {
      ...currentConfig,
      memory: { activeProfile: "zai-default", model: "glm-5.3-flash" },
    };
    const saveProviderSettings = vi.fn(async () => buildProviderModelsSettings(currentConfig));
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadProviderSettings: vi.fn(async () => buildProviderModelsSettings(overrideConfig)),
      saveProviderSettings,
    };

    render(<ProviderModelsSettingsPage settingsStore={settingsStore} />);

    const memoryPanel = (await screen.findByRole("heading", { name: "Memory model" })).closest("section");
    const memory = within(memoryPanel!);
    await user.selectOptions(
      memory.getByRole("combobox", { name: "Model used for Memory" }),
      memory.getByRole("option", { name: "Follow global default — deepseek-v4-pro · DeepSeek" }),
    );
    await user.click(memory.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledWith(overrideConfig, {
      memory: {
        activeProfile: { __desktopConfigOperation: "remove" },
        model: { __desktopConfigOperation: "remove" },
      },
    }));
  });

  test("discovers models from the built-in local Ollama provider", async () => {
    const user = userEvent.setup();
    const fetchProviderModels = vi.fn(async () => ({
      ok: true,
      models: ["qwen3:8b"],
    }));
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadProviderSettings: vi.fn(async () => buildProviderModelsSettings(currentConfig)),
      fetchProviderModels,
    };

    render(<ProviderModelsSettingsPage settingsStore={settingsStore} />);

    const ollamaCard = await screen.findByLabelText("Ollama provider");
    expect(ollamaCard.querySelector("img")?.getAttribute("src")).toBe("/assets/providers/ollama.svg");
    await user.click(await screen.findByRole("button", { name: "Manage Ollama models" }));
    await user.click(screen.getByRole("button", { name: "Refresh models" }));

    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith({
      providerId: "ollama",
      profileId: "ollama-default",
      apiBase: "http://127.0.0.1:11434/v1",
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    }));
    expect(await screen.findByText("qwen3:8b")).toBeTruthy();
  });

  test("persists the default Provider and model natively before updating the renderer preference", async () => {
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const saveResult = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const saveDefaultChatModel = vi.fn(async (input: { modelId: string; providerId: string }) => {
      await saveResult;
      writeDefaultChatModel(input.modelId, input.providerId);
    });
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadProviderSettings: vi.fn()
        .mockResolvedValueOnce(buildProviderModelsSettings(currentConfig))
        .mockResolvedValue(buildProviderModelsSettings(zaiConfig)),
      saveDefaultChatModel,
    };

    render(<ProviderModelsSettingsPage settingsStore={settingsStore} />);

    await user.click(await screen.findByRole("button", { name: "Change model" }));
    await user.click(screen.getByRole("button", { name: "Select Z.ai provider" }));
    await user.click(screen.getByRole("radio", { name: "Select glm-5.3-flash model" }));
    await user.click(screen.getByRole("button", { name: "Save default model" }));

    await waitFor(() => expect(saveDefaultChatModel).toHaveBeenCalledWith({
      modelId: "glm-5.3-flash",
      providerId: "zai",
    }));
    expect(readDefaultChatModelPreference()).toEqual({
      modelId: "deepseek-v4-pro",
      providerId: "deepseek",
    });

    resolveSave();

    await waitFor(() => expect(readDefaultChatModelPreference()).toEqual({
      modelId: "glm-5.3-flash",
      providerId: "zai",
    }));
  });
});
