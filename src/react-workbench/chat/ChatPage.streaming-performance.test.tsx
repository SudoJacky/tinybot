// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ChatEvent } from "../services";
import { ChatPageUnderTest, createStores } from "./test/ChatPageTestHarness";

const renders = vi.hoisted(() => ({ composer: 0, historicalMarkdown: 0 }));
vi.mock("../../components/ui/claude-style-ai-input", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../components/ui/claude-style-ai-input")>();
  return { ...original, ClaudeStyleAiInput: (props: Parameters<typeof original.ClaudeStyleAiInput>[0]) => {
    renders.composer += 1;
    return <original.ClaudeStyleAiInput {...props} />;
  } };
});
vi.mock("./AssistantMarkdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("./AssistantMarkdown")>();
  return { ...original, AssistantMarkdown: (props: Parameters<typeof original.AssistantMarkdown>[0]) => {
    if (props.text === "Historical answer") renders.historicalMarkdown += 1;
    return <original.AssistantMarkdown {...props} />;
  } };
});

test("streaming text updates the answer without rerendering the composer or history", async () => {
  const stores = createStores();
  const initial = await stores.chatStore.load("s1");
  const history = { ...initial.turns[0], id: "history", status: "completed" as const,
    finalAnswer: { id: "historical-answer", role: "assistant" as const, text: "Historical answer", timestamp: "2026-01-01" } };
  const active = { ...initial.turns[0], id: "active", status: "running" as const,
    finalAnswer: { ...history.finalAnswer, id: "active-answer", text: "Streaming 0" } };
  const snapshot = { ...initial, turns: [history, active] };
  vi.mocked(stores.chatStore.load).mockResolvedValue(snapshot);
  let receive!: (event: ChatEvent) => void;
  stores.chatStore.subscribe = vi.fn((session, listener) => { if (session === "s1") receive = listener; return () => {}; });
  render(<ChatPageUnderTest {...stores} />);
  await screen.findByText("Streaming 0");
  await act(async () => {});
  // Establish the running session boundary before measuring text-only updates.
  act(() => receive({ type: "agent_timeline_updated", timeline: snapshot }));
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  const before = { ...renders };
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const view = document.querySelector<HTMLElement>(".react-conversation-view")!;
  const end = view.lastElementChild;
  scroll.mockClear();
  for (let index = 1; index <= 5; index += 1) {
    act(() => receive({ type: "agent_timeline_updated", timeline: { ...snapshot,
      turns: [history, { ...active, finalAnswer: { ...active.finalAnswer, text: `Streaming 0${".".repeat(index)}` } }],
    } }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    await waitFor(() => expect(screen.getByText(`Streaming 0${".".repeat(index)}`)).toBeTruthy());
  }
  const counts = { composer: renders.composer - before.composer,
    historicalMarkdown: renders.historicalMarkdown - before.historicalMarkdown };
  console.info("[chat-performance] rendering", { frames: 5, ...counts });
  expect(counts).toEqual({ composer: 0, historicalMarkdown: 0 });
  expect(scroll.mock.instances.filter((element) => element === end)).toHaveLength(5);
  Object.defineProperties(view, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, writable: true, value: 500 },
  });
  fireEvent.scroll(view);
  await act(async () => {});
  scroll.mockClear();
  act(() => receive({ type: "timeline.patch", timeline: { ...snapshot,
    turns: [history, { ...active, finalAnswer: { ...active.finalAnswer, text: "Streaming 0......" } }],
  } }));
  await screen.findByText("Streaming 0......");
  expect(scroll.mock.instances.filter((element) => element === end)).toHaveLength(0);
  expect(view.scrollTop).toBe(500);
  act(() => receive({ type: "timeline.patch", timeline: { ...snapshot,
    turns: [history, { ...active, status: "completed", finalAnswer: { ...active.finalAnswer, text: "Final answer" } }],
  } }));
  expect(await screen.findByText("Final answer")).toBeTruthy();
  expect(view.querySelector('[data-scroll-anchor="turn:active"]')?.getAttribute("data-status")).toBe("completed");
  expect(view.scrollTop).toBe(500);
  scroll.mockRestore();
});
