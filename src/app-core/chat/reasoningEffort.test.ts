// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from "vitest";

import {
  CHAT_REASONING_EFFORT_STORAGE_KEY,
  readCurrentChatReasoningEffort,
  writeCurrentChatReasoningEffort,
} from "./reasoningEffort";

describe("chat reasoning effort preference", () => {
  beforeEach(() => window.localStorage.clear());

  test("persists supported explicit effort values", () => {
    writeCurrentChatReasoningEffort("xhigh");

    expect(readCurrentChatReasoningEffort()).toBe("xhigh");
  });

  test.each(["none", "ultra"])("removes unsupported effort value %s and falls back to high", (effort) => {
    window.localStorage.setItem(CHAT_REASONING_EFFORT_STORAGE_KEY, effort);

    expect(readCurrentChatReasoningEffort()).toBe("high");
    expect(window.localStorage.getItem(CHAT_REASONING_EFFORT_STORAGE_KEY)).toBeNull();
  });

  test("uses high when no preference has been saved", () => {
    expect(readCurrentChatReasoningEffort()).toBe("high");
  });
});
