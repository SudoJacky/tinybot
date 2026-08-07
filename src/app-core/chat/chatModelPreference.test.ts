// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from "vitest";
import {
  CHAT_CURRENT_MODEL_STORAGE_KEY,
  readCurrentChatModelPreference,
  writeCurrentChatModel,
} from "./chatModelPreference";

describe("chat model preference", () => {
  beforeEach(() => window.localStorage.clear());

  test("persists the provider together with the selected model", () => {
    writeCurrentChatModel("gpt-5", "openai");

    expect(readCurrentChatModelPreference()).toEqual({
      modelId: "gpt-5",
      providerId: "openai",
    });
  });

  test("reads legacy model-only preferences", () => {
    window.localStorage.setItem(CHAT_CURRENT_MODEL_STORAGE_KEY, "deepseek-chat");

    expect(readCurrentChatModelPreference()).toEqual({ modelId: "deepseek-chat" });
  });
});
