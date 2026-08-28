// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
