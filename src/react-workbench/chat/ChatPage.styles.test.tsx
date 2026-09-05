// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  mountWorkbenchCss,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
  it("keeps expanded execution timelines at max-content height inside the conversation grid", async () => {
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-layout",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect layout",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "commentary-layout",
      kind: "message",
      messagePhase: "commentary",
      modelCallId: "call-layout",
      sequence: 1,
      status: "completed",
      summary: "Inspecting layout.",
      title: "Progress update",
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed: Running/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    mountWorkbenchCss();
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    expect(getComputedStyle(executionTimeline).height).toBe("max-content");
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
});
