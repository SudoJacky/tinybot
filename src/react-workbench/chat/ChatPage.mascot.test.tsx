// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  mockLatestTurnStatus,
} from "./test/ChatPageTestHarness";

describe("ChatPage mascot", () => {
  it.each([
    ["awaiting_user" as const, "curious"],
    ["running" as const, "working"],
    ["failed" as const, "angry"],
    ["interrupted" as const, "angry"],
    ["completed" as const, "pleased"],
  ])("projects the %s Turn status to the shell mascot", async (turnStatus, mood) => {
    const stores = createStores();
    const onMascotMoodChange = vi.fn();
    await mockLatestTurnStatus(stores.chatStore, turnStatus);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        sessionStore={stores.sessionStore}
        onMascotMoodChange={onMascotMoodChange}
      />,
    );

    await waitFor(() => expect(onMascotMoodChange).toHaveBeenLastCalledWith(mood));
    expect(document.querySelector(".react-tinybot-mascot")).toBeNull();
  });
});
