// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatStep, ChatTurn } from "../../app-core/chat/chatTurnContracts";
import { parseDataViewDocument } from "../../app-core/chat/dataView";
import type { ReactChatMessage } from "./messageActions";
import { ChatTimeline, type ChatTimelineActions } from "./ChatTimeline";
import { timelineFromReactMessages } from "./test/timelineFixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatTimeline", () => {
  test("renders canonical and optimistic messages and routes message actions through its interface", () => {
    const actions = createActions();
    const turn = completedTurn();
    render(
      <ChatTimeline
        actions={actions}
        error="Timeline connection failed"
        hookResults={[]}
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[optimisticMessage()]}
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

  test("shows failed turns inline with copy as the only error action", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const actions = createActions();
    const turn = failedTurn();
    render(
      <ChatTimeline
        actions={actions}
        hookResults={[]}
        interactiveFormIds={new Set()}
        latestFailedTurnId={turn.id}
        optimisticMessages={[]}
        sessionRunning={false}
        turns={[turn]}
      />,
    );

    const error = screen.getByRole("alert", { name: "Task execution failed" });
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Error message: Execution failed"));
    expect(error.querySelector(".react-execution-error__message")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /retry|continue|details/i })).toBeNull();
  });

  test("keeps inline errors available when embedded as a read-only timeline", () => {
    render(
      <ChatTimeline
        actions={{}}
        hookResults={[]}
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[]}
        sessionRunning={false}
        turns={[completedTurn(), failedTurn()]}
      />,
    );

    expect(screen.queryByRole("button", { name: /branch/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^details$/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeTruthy();
    expect(screen.getByText("Canonical answer")).toBeTruthy();
    expect(screen.getByText("Execution failed")).toBeTruthy();
  });

  test("shows completed hook results inside their canonical turn", () => {
    const turn = completedTurn();
    render(
      <ChatTimeline
        actions={createActions()}
        hookResults={[{
          decision: "continue",
          durationMs: 42,
          hookName: "Reviewing tool input",
          id: "hook-1",
          stage: "PreToolUse",
          toolCallId: "tool-1",
          turnId: turn.id,
        }, {
          decision: "failed",
          durationMs: 17,
          failure: "Script exited with code 1",
          hookName: "Validate tool call",
          id: "hook-2",
          stage: "PreToolUse",
          toolCallId: "tool-1",
          turnId: turn.id,
        }]}
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[]}
        sessionRunning={false}
        turns={[turn]}
      />,
    );

    const results = screen.getByRole("list", { name: "Hook results" });
    expect(results.textContent).toContain("Reviewing tool input");
    expect(results.textContent).toContain("Before tool use · Continued · 42 ms");
    expect(results.textContent).toContain("Before tool use · Failed · 17 ms");
    expect(screen.getByText("Script exited with code 1").closest("li")?.dataset.status).toBe("error");
    expect(results.textContent).not.toContain("tool-1");
  });

  test("keeps a published data view at its execution position", () => {
    const turn = dataViewTurn();
    const { container } = render(
      <ChatTimeline
        actions={createActions()}
        hookResults={[]}
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[]}
        sessionRunning={false}
        turns={[turn]}
      />,
    );

    const dataView = container.querySelector<HTMLElement>(".react-data-view");
    const laterUpdate = screen.getByText("Continue after publishing.");
    const finalAnswer = screen.getByText("Canonical answer");
    if (!dataView) {
      throw new Error("Expected the published data view to render");
    }
    expect((dataView.closest(".react-execution-timeline__item") as HTMLElement | null)?.dataset.kind).toBe("tool_call");
    expect(dataView.compareDocumentPosition(laterUpdate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dataView.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("streams canonical reasoning beside its timer and folds it back to the beginning when complete", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:05.000Z"));
    const reasoningStep: ChatStep = {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "reasoning-live",
      kind: "reasoning",
      sequence: 1,
      startedAt: "2026-09-02T00:00:00.000Z",
      status: "running",
      summary: "Inspecting the workspace.",
      title: "Thinking",
    };
    const turn: ChatTurn = {
      id: "turn-reasoning-live",
      sessionKey: "session-reasoning-live",
      startedAt: "2026-09-02T00:00:00.000Z",
      status: "running",
      steps: [reasoningStep],
      executionItems: [reasoningStep],
      updatedAt: "2026-09-02T00:00:05.000Z",
      userMessage: {
        id: "user-reasoning-live",
        role: "user",
        text: "Inspect first",
        timestamp: "2026-09-02T00:00:00.000Z",
      },
      userMessageId: "user-reasoning-live",
    };
    const view = (step: ChatStep) => (
      <ChatTimeline
        actions={createActions()}
        hookResults={[]}
        interactiveFormIds={new Set()}
        latestFailedTurnId=""
        optimisticMessages={[]}
        sessionRunning
        turns={[{ ...turn, executionItems: [step], steps: [step] }]}
      />
    );
    const { rerender } = render(view(reasoningStep));

    const reasoning = screen.getByLabelText("Reasoning");
    const toggle = within(reasoning).getByRole("button", { name: "Thinking · 5s" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const content = within(reasoning).getByTestId("execution-reasoning-content");
    expect(content.textContent).toContain("Inspecting the workspace.");
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 120 });

    const streamedStep = { ...reasoningStep, summary: "Inspecting the workspace.\nChecking the tests." };
    rerender(view(streamedStep));
    expect(content.scrollTop).toBe(120);
    act(() => vi.advanceTimersByTime(1_000));
    expect(within(reasoning).getByRole("button", { name: "Thinking · 6s" })).toBeTruthy();

    rerender(view({
      ...streamedStep,
      completedAt: "2026-09-02T00:00:07.000Z",
      status: "completed",
    }));
    const completedToggle = within(reasoning).getByRole("button", { name: "Thought for 7 seconds" });
    expect(completedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByTestId("execution-reasoning-content")).toBeNull();

    fireEvent.click(completedToggle);
    const reopenedContent = within(reasoning).getByTestId("execution-reasoning-content");
    expect(reopenedContent.scrollTop).toBe(0);
    expect(reopenedContent.textContent).toContain("Inspecting the workspace.");
  });
});

function createActions(): ChatTimelineActions {
  return {
    onBranch: vi.fn(),
    onOpenArtifact: vi.fn(),
    onOpenSubagent: vi.fn(),
    onOpenTool: vi.fn(),
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

function dataViewTurn(): ChatTurn {
  const turn = completedTurn();
  const step = (patch: Partial<ChatStep> & Pick<ChatStep, "id" | "kind" | "sequence" | "title">): ChatStep => ({
    agentContext: { id: "main", title: "Tinybot", type: "main" },
    status: "completed",
    ...patch,
  });
  const executionItems = [
    step({
      id: "message-before-chart",
      kind: "message",
      messageId: "message-before-chart",
      messagePhase: "commentary",
      modelCallId: "provider-1",
      sequence: 1,
      summary: "Publishing the chart.",
      title: "Progress update",
    }),
    step({
      artifacts: [{
        id: "data-view-1",
        kind: "data_view",
        title: "Repository stars",
        dataView: parseDataViewDocument({
          schemaVersion: "tinybot.data_view.v1",
          title: "Repository stars",
          insight: "Repository A leads.",
          dataset: {
            columns: [{ key: "repo", label: "Repository", type: "category" }],
            rows: [{ id: "repo-a", values: { repo: "Repository A" } }],
          },
          view: { kind: "table", columns: ["repo"] },
          provenance: { status: "user_provided", sources: [] },
        }),
      }],
      id: "publish-chart",
      kind: "tool_call",
      sequence: 2,
      title: "publish_data_view",
      toolCall: { id: "publish-chart", name: "publish_data_view" },
    }),
    step({
      id: "message-after-chart",
      kind: "message",
      messageId: "message-after-chart",
      messagePhase: "commentary",
      modelCallId: "provider-2",
      sequence: 3,
      summary: "Continue after publishing.",
      title: "Progress update",
    }),
  ];
  return { ...turn, executionItems, steps: executionItems };
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
