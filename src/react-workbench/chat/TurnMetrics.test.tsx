// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import { ChatTimeline } from "./ChatTimeline";

afterEach(cleanup);

function turn(id: string, patch: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id, sessionKey: "session", status: "completed", startedAt: "1000", completedAt: "20000", updatedAt: "20000",
    steps: [], executionItems: [], userMessageId: `user-${id}`,
    userMessage: { id: `user-${id}`, role: "user", text: "Question", timestamp: "1000" },
    finalAnswer: { id: `answer-${id}`, role: "assistant", text: "Answer", timestamp: "20000" },
    metrics: { timeToFirstTokenMs: 600, tokensPerSecond: 108 }, ...patch,
  };
}

function timeline(turns: ChatTurn[]) {
  return <ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} />;
}

describe("turn timing footer", () => {
  test("places one timing button beside final-answer actions for each settled turn", () => {
    render(timeline([turn("one"), turn("two")]));
    expect(screen.getAllByRole("button", { name: "Took 19s" })).toHaveLength(2);
    const answer = screen.getByTestId("message-answer-one");
    const trigger = within(answer).getByRole("button", { name: "Took 19s" });
    expect(trigger.parentElement).toBe(within(answer).getByRole("button", { name: "Copy message" }).parentElement);
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Turn time and speed" });
    expect(document.activeElement).toBe(dialog);
    expect(within(dialog).getByText("108 tok/s")).toBeTruthy();
    expect(within(dialog).getByText("0.6s")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows duration alone for old records, including failed turns without a final answer", () => {
    render(timeline([turn("old", { metrics: undefined, finalAnswer: undefined, status: "failed" })]));
    fireEvent.click(screen.getByRole("button", { name: "Took 19s" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Total turn time")).toBeTruthy();
    expect(within(dialog).queryByText("Output speed (TPS)")).toBeNull();
    expect(within(dialog).queryByText("Time to first token (TTFT)")).toBeNull();
  });

  test("does not display a completed metric while a turn is running or waiting for input", () => {
    const { rerender } = render(timeline([turn("active", { status: "running" })]));
    expect(screen.queryByRole("button", { name: /Took/ })).toBeNull();
    rerender(timeline([turn("active", { status: "awaiting_user" })]));
    expect(screen.queryByRole("button", { name: /Took/ })).toBeNull();
    rerender(timeline([turn("active", { status: "interrupted" })]));
    expect(screen.getByRole("button", { name: "Took 19s" })).toBeTruthy();
  });
});
