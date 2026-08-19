// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatStep, ChatTurn } from "../../app-core/chat/chatTurnContracts";
import type { ReactChatMessage } from "./messageActions";
import { ChatTimeline, type ChatTimelineActions } from "./ChatTimeline";
import { timelineFromReactMessages } from "./test/timelineFixtures";

afterEach(cleanup);

describe("ChatTimeline", () => {
  test("renders canonical and optimistic messages and routes message actions through its interface", () => {
    const actions = createActions();
    const turn = completedTurn();
    render(
      <ChatTimeline
        actions={actions}
        error="Timeline connection failed"
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[optimisticMessage()]}
        recoveringTurnId=""
        sessionRunning={false}
        turns={[turn]}
      />,
    );

    expect(screen.getByText("Timeline connection failed").getAttribute("aria-live")).toBe("assertive");
    expect(screen.getByText("Canonical answer")).toBeTruthy();
    expect(screen.getByText("Pending answer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /branch/i }));
    expect(actions.onBranch).toHaveBeenCalledWith("assistant-1");
  });

  test("keeps failed-turn recovery and error details behind timeline actions", () => {
    const actions = createActions();
    const turn = failedTurn();
    render(
      <ChatTimeline
        actions={actions}
        interactiveFormIds={new Set()}
        latestFailedTurnId={turn.id}
        optimisticMessages={[]}
        recoveringTurnId=""
        sessionRunning={false}
        turns={[turn]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(actions.onRecover).toHaveBeenCalledWith(turn, "retry");

    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(actions.onOpenError).toHaveBeenCalledWith(turn, turn.steps[0]);
  });
});

function createActions(): ChatTimelineActions {
  return {
    onBranch: vi.fn(),
    onOpenArtifact: vi.fn(),
    onOpenError: vi.fn(),
    onOpenSubagent: vi.fn(),
    onOpenTool: vi.fn(),
    onRecover: vi.fn(),
  };
}

function completedTurn(): ChatTurn {
  return timelineFromReactMessages("session-1", [
    {
      createdAtMs: 1,
      id: "user-1",
      role: "user",
      status: "complete",
      text: "Canonical question",
      turnId: "turn-1",
    },
    {
      createdAtMs: 2,
      id: "assistant-1",
      role: "assistant",
      status: "complete",
      text: "Canonical answer",
      turnId: "turn-1",
      turnStatus: "completed",
    },
  ]).turns[0];
}

function failedTurn(): ChatTurn {
  const base = completedTurn();
  const errorStep: ChatStep = {
    agentContext: { id: "main", title: "Tinybot", type: "main" },
    error: { code: "runtime_error", message: "Execution failed" },
    id: "error-1",
    kind: "error",
    sequence: 1,
    status: "failed",
    summary: "Execution failed",
    title: "Execution failed",
  };
  return {
    ...base,
    finalMessage: undefined,
    status: "failed",
    steps: [errorStep],
  };
}

function optimisticMessage(): ReactChatMessage {
  return {
    createdAtMs: 3,
    id: "optimistic-1",
    role: "assistant",
    status: "streaming",
    text: "Pending answer",
  };
}
