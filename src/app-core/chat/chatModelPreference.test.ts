// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from "vitest";
import {
  CHAT_DEFAULT_MODEL_STORAGE_KEY,
  readDefaultChatModelPreference,
  writeDefaultChatModel,
} from "./chatModelPreference";

describe("chat model preference", () => {
  beforeEach(() => window.localStorage.clear());

  test("persists the provider together with the selected model", () => {
    writeDefaultChatModel("gpt-5", "openai");

    expect(readDefaultChatModelPreference()).toEqual({
      modelId: "gpt-5",
      providerId: "openai",
    });
  });

  test("keeps reading the existing model-only storage format", () => {
    window.localStorage.setItem(CHAT_DEFAULT_MODEL_STORAGE_KEY, "deepseek-chat");

    expect(readDefaultChatModelPreference()).toEqual({ modelId: "deepseek-chat" });
  });
});
