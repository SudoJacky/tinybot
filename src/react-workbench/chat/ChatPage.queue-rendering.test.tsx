// @vitest-environment happy-dom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ChatPageUnderTest, createStores } from "./test/ChatPageTestHarness";

const renders = vi.hoisted(() => ({ timeline: 0 }));
vi.mock("./ChatTimeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ChatTimeline")>();
  return {
    ...original,
    ChatTimeline: (props: Parameters<typeof original.ChatTimeline>[0]) => {
      renders.timeline += 1;
      return <original.ChatTimeline {...props} />;
    },
  };
});

it("updates the queue after deletion without rerendering the conversation or refreshing sessions", async () => {
  const user = userEvent.setup();
  const stores = createStores({ sessions: [{
    id: "s1", chatId: "s1", title: "Chat", status: "running", updatedAtMs: 0,
  }] });
  const timeline = await stores.chatStore.load("s1");
  timeline.turns[timeline.turns.length - 1].status = "running";
  vi.mocked(stores.chatStore.load).mockResolvedValue(timeline);
  render(<ChatPageUnderTest {...stores} />);
  await user.type(await screen.findByRole("textbox", { name: /message/i }), "queued message{enter}");
  await waitFor(() => expect(screen.getByLabelText("Queued inputs").textContent).toContain("queued message"));
  await act(async () => {});
  const before = { renders: renders.timeline, refreshes: vi.mocked(stores.sessionStore.list).mock.calls.length };
  await user.click(screen.getByRole("button", { name: "Delete queued input" }));
  expect(screen.queryByLabelText("Queued inputs")).toBeNull();
  expect(renders.timeline - before.renders).toBe(0);
  expect(vi.mocked(stores.sessionStore.list).mock.calls.length - before.refreshes).toBe(0);
});
