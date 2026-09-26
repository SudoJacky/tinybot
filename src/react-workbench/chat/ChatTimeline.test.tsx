// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatStep, ChatTurn } from "../../app-core/chat/chatTurnContracts";
import { parseDataViewDocument } from "../../app-core/chat/dataView";
import type { ReactChatMessage } from "./messageActions";
import { ChatTimeline, type ChatTimelineActions } from "./ChatTimeline";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import { createAgentTimelineModel } from "../../app-core/chat/agentTimelineModel";
import { ChatTeamContext } from "../teams/chatTeamContext";
import { recruitmentRun, recruitmentRuntime } from "./test/teamRecruitmentFixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatTimeline", () => {
  test.each(["object", "json-string"])("keeps each successful recruitment batch through later waves, status updates, reopening and canonical reload (%s arguments)", (argumentFormat) => {
    const first = recruitmentRun();
    first.revision = 1;
    first.tasks = first.tasks.slice(0, 2);
    first.spec.members = first.spec.members.slice(0, 2);
    const latest = recruitmentRun();
    latest.tasks[0].status = "succeeded";
    latest.tasks[1].status = "failed";
    const open = vi.fn();
    const persisted = recruitmentRuntime(latest);
    const view = (run: typeof latest, payload = persisted) => {
      const items = payload.timeline.items.map(item => ({ ...item, data: { ...item.data,
        args: argumentFormat === "json-string" ? JSON.stringify(item.data.args) : item.data.args,
      } }));
      const saved = { ...payload, timeline: { ...payload.timeline, items } };
      const turns = createAgentTimelineModel().load("recruitment-chat", [JSON.parse(JSON.stringify(saved))]).turns;
      // Preview text is presentation-only; identity must use the full arguments.
      turns[0].steps[0].toolCall!.argsPreview = "Clipped display preview";
      return <ChatTeamContext.Provider value={{ run, selectedTaskId: "verify", open }}>
        <ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} />
      </ChatTeamContext.Provider>;
    };
    const { container, rerender, unmount } = render(view(first, recruitmentRuntime(first, [["sources", "compare"]])));
    const expand = (root: HTMLElement) => {
      const cards = Array.from(root.querySelectorAll<HTMLDetailsElement>(".chat-team-card"));
      for (const card of cards) { card.open = true; fireEvent(card, new Event("toggle")); }
      return cards;
    };
    let cards = expand(container);
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getAllByRole("button")).toHaveLength(2);
    rerender(view(latest));
    cards = expand(container);
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("summary")?.textContent).toContain("Employees in this batch: 2 · Tasks: 2");
    expect(cards[1].querySelector("summary")?.textContent).toContain("Employees in this batch: 1 · Tasks: 1");
    expect(within(cards[0]).getAllByRole("button")).toHaveLength(2);
    expect(within(cards[0]).queryByText("Verify evidence")).toBeNull();
    expect(within(cards[0]).getByText("Completed")).toBeTruthy();
    expect(within(cards[0]).getByText("Failed")).toBeTruthy();
    const second = within(cards[1]).getByRole("button", { name: /Alex.*Verify evidence/ });
    expect(second.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(second);
    expect(open).toHaveBeenLastCalledWith(latest, "verify", second);
    rerender(view(first));
    expect(within(cards[0]).getByText("Failed")).toBeTruthy();
    expect(within(cards[1]).getByText("Verify evidence")).toBeTruthy();
    cards[0].open = false; fireEvent(cards[0], new Event("toggle"));
    cards = expand(container);
    expect(within(cards[0]).getAllByRole("button")).toHaveLength(2);
    unmount();
    const reloaded = render(view(latest));
    cards = expand(reloaded.container);
    expect(within(cards[0]).getAllByRole("button")).toHaveLength(2);
    expect(within(cards[1]).getAllByRole("button")).toHaveLength(1);
    expect(within(cards[0]).queryByText("Verify evidence")).toBeNull();
  });

  test("counts existing employees once when a later call assigns them multiple new tasks", () => {
    const run = recruitmentRun();
    run.tasks.push(...["summarize", "cross-check"].map(id => ({ ...run.tasks[0], task: { ...run.tasks[0].task, id, title: id } })));
    const payload = recruitmentRuntime(run, [["sources", "compare"], ["verify"], ["summarize", "cross-check"]]);
    expect(payload.timeline.items[2].data.args.members).toEqual([]);
    const turns = createAgentTimelineModel().load("recruitment-chat", [payload]).turns;
    const open = vi.fn();
    const { container } = render(<ChatTeamContext.Provider value={{ run, open }}><ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} /></ChatTeamContext.Provider>);
    const cards = container.querySelectorAll<HTMLDetailsElement>(".chat-team-card");
    const later = cards[2]; later.open = true; fireEvent(later, new Event("toggle"));
    expect(later.querySelector("summary")?.textContent).toContain("Employees in this batch: 1 · Tasks: 2");
    expect(within(later).getAllByRole("button")).toHaveLength(2);
    expect(within(later).queryByText("Collect sources")).toBeNull();
    fireEvent.click(within(later).getByRole("button", { name: /cross-check/ }));
    expect(open).toHaveBeenLastCalledWith(run, "cross-check", expect.any(HTMLButtonElement));
  });

  test("makes a legacy recruitment scope explicit and keeps the team reachable without inventing a roster", () => {
    const run = recruitmentRun();
    const payload = recruitmentRuntime(run, [["sources", "compare"]]);
    const item = payload.timeline.items[0];
    const turns = createAgentTimelineModel().load("recruitment-chat", [{ ...payload, timeline: { ...payload.timeline, items: [{ ...item, data: { ...item.data, args: undefined } }] } }]).turns;
    const open = vi.fn();
    const { container } = render(<ChatTeamContext.Provider value={{ run, open }}><ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} /></ChatTeamContext.Provider>);
    const card = container.querySelector(".chat-team-card") as HTMLDetailsElement;
    card.open = true; fireEvent(card, new Event("toggle"));
    expect(card.querySelector("summary")?.textContent).toBe("Agent recruitment");
    expect(screen.getByText(/no recruitment batch details/)).toBeTruthy();
    expect(card.querySelector(".chat-team-card__employees")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View team" }));
    expect(open).toHaveBeenCalledWith(run, "sources", expect.any(HTMLButtonElement));
  });

  test.each(["running", "failed", "cancelled", "denied", "truncated", "mismatched", "invalid-args", "invalid-result"])("retains the original tool record without a success card for %s recruitment", (failure) => {
    const run = recruitmentRun();
    const payload = recruitmentRuntime(run, [["sources", "compare"]]);
    const item = payload.timeline.items[0];
    const status = ["running", "failed", "cancelled"].includes(failure) ? failure : "completed";
    const result = failure === "running" ? undefined : failure === "denied" ? { ...item.data.result, status: "denied" }
      : failure === "truncated" ? { ...item.data.result, truncated: true }
      : failure === "mismatched" ? { ...item.data.result, raw: { ...item.data.result.raw, runId: "different-run", tasks: [{ taskId: "sources", memberId: "wrong-member" }] } }
      : failure === "invalid-result" ? { raw: '{"runId": "truncated' } : item.data.result;
    const turns = createAgentTimelineModel().load("recruitment-chat", [{ ...payload, status: failure === "running" ? "running" : payload.status, timeline: { ...payload.timeline, items: [{ ...item, status, data: { ...item.data, status, result,
      args: failure === "invalid-args" ? '{"tasks": [' : JSON.stringify(item.data.args) } }] } }]).turns;
    const { container } = render(<ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} />);
    expect(container.querySelector(".chat-team-card")).toBeNull();
    expect(container.querySelector(".react-tool-activity")).not.toBeNull();
    if (["truncated", "mismatched", "invalid-args", "invalid-result"].includes(failure)) expect(screen.getByRole("alert").textContent).toContain("incomplete or inconsistent");
  });

  test.each(["null", "[]", '{"arguments":{"members":[],"tasks":[]}}'])("keeps invalid saved argument shapes explicit instead of treating them as missing (%s)", (args) => {
    const run = recruitmentRun();
    const payload = recruitmentRuntime(run, [["sources", "compare"]]);
    const item = payload.timeline.items[0];
    const turns = createAgentTimelineModel().load("recruitment-chat", [{ ...payload, timeline: { ...payload.timeline,
      items: [{ ...item, data: { ...item.data, args } }],
    } }]).turns;
    const { container } = render(<ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={turns} />);
    expect(container.querySelector(".chat-team-card")).toBeNull();
    expect(container.querySelector(".react-tool-activity")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("incomplete or inconsistent");
  });

  test("shows real retry progress while running and hides it on completion or failure", () => {
    const base = completedTurn();
    const retry = { turnId: base.id, modelCallId: "model-1", attempt: 1, maxRetries: 3, delayMs: 200, reason: "server_error" as const };
    const view = (turn: ChatTurn, progress = retry) => <ChatTimeline actions={{}} hookResults={[]}
      interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning
      providerRetry={progress} turns={[turn]} />;
    const running = { ...base, status: "running" as const };
    const { rerender } = render(view(running));
    expect(screen.getByRole("status").textContent).toContain("Retrying in 0.2 s (1/3)");
    expect(screen.getByRole("status").textContent).toContain("Service temporarily unavailable");
    expect(screen.queryByRole("img", { name: "Agent is responding" })).toBeNull();
    expect(screen.getByRole("status").closest("section")?.dataset.status).toBe("running");
    rerender(view(running, { ...retry, delayMs: 0 }));
    expect(screen.getByRole("status").textContent).toContain("Retrying request (1/3)");
    rerender(view(running, { ...retry, turnId: "another-turn" }));
    expect(screen.queryByRole("status")).toBeNull();
    for (const status of ["completed", "failed", "interrupted"] as const) {
      rerender(view({ ...base, status }));
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  test("shows workspace and uploaded files as chips inside persisted user bubbles", () => {
    const turn = completedTurn();
    const onOpenFileLink = vi.fn();
    turn.userMessage.references = [
      { kind: "reference", referenceKind: "file", title: "sales.xlsx", detail: "Whole artifact", sourcePath: "reports/sales.xlsx", sourceText: "Artifact: sales.xlsx\nViewed content" },
      { kind: "reference", referenceKind: "file", title: "notes.pdf", detail: "PDF - 2 KB", rawPath: "C:/uploads/notes.pdf" },
    ];
    render(<ChatTimeline actions={{ onOpenFileLink }} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId="" optimisticMessages={[]} sessionRunning={false} turns={[turn]} />);
    const message = screen.getByTestId("message-user-1");
    const attachments = within(message).getByRole("region", { name: "Attachments" });
    expect(message.querySelector(".react-message__body")?.contains(attachments)).toBe(true);
    expect(within(attachments).getByText("sales.xlsx")).toBeTruthy();
    expect(within(attachments).getByText("notes.pdf")).toBeTruthy();
    expect(within(message).queryByText("Context")).toBeNull();
    expect(message.textContent).not.toContain("Whole artifact");
    const file = within(attachments).getByRole("button", { name: /sales.xlsx/ });
    expect(file.title).toContain("reports/sales.xlsx");
    fireEvent.click(file);
    expect(onOpenFileLink).toHaveBeenCalledWith({ href: "reports/sales.xlsx" });
  });

  test("keeps one indicator at the turn tail through dispatch, tools, and answer streaming", () => {
    const base = completedTurn();
    const timeline = (turns: ChatTurn[], optimisticMessages: ReactChatMessage[] = []) => (
      <ChatTimeline actions={{}} hookResults={[]} interactiveFormIds={new Set()} latestFailedTurnId=""
        optimisticMessages={optimisticMessages} sessionRunning turns={turns} />
    );
    const { rerender } = render(timeline([], [optimisticMessage()]));
    expect(screen.getAllByRole("img", { name: "Agent is responding" })).toHaveLength(1);

    const pending: ChatTurn = { ...base, status: "pending", finalMessage: undefined, executionItems: [], steps: [] };
    rerender(timeline([pending], [optimisticMessage()]));
    const indicator = screen.getByRole("img", { name: "Agent is responding" });
    const turnElement = indicator.closest(".react-canonical-turn")!;
    expect(turnElement.lastElementChild).toBe(indicator);
    expect(screen.getAllByRole("img", { name: "Agent is responding" })).toHaveLength(1);

    const tool: ChatStep = {
      id: "tool-running", kind: "tool_call", sequence: 1, title: "Read file", status: "running",
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      toolCall: { id: "tool-running", name: "read_file" },
    };
    const running: ChatTurn = { ...pending, status: "running", executionItems: [tool], steps: [tool] };
    rerender(timeline([running]));
    expect(screen.getByRole("img", { name: "Agent is responding" })).toBe(indicator);
    expect(turnElement.lastElementChild).toBe(indicator);

    rerender(timeline([{ ...running, finalMessage: base.finalMessage }]));
    expect(screen.getByTestId("message-assistant-1").textContent).toContain("Canonical answer");
    expect(screen.getAllByRole("img", { name: "Agent is responding" })).toEqual([indicator]);
    expect(turnElement.lastElementChild).toBe(indicator);

    rerender(timeline([{ ...running, status: "awaiting_user" }]));
    expect(screen.queryByRole("img", { name: "Agent is responding" })).toBeNull();
    const waiting = screen.getByRole("img", { name: "Awaiting input" });
    expect(waiting.textContent).toBe("Awaiting input");
    expect(waiting.querySelector(".react-agent-response__board")).toBeNull();
    expect(turnElement.lastElementChild).toBe(waiting);

    rerender(timeline([running]));
    expect(screen.getByRole("img", { name: "Agent is responding" })).toBe(indicator);
    for (const status of ["completed", "failed", "interrupted"] as const) {
      rerender(timeline([{ ...running, status, finalMessage: base.finalMessage }]));
      expect(screen.queryByRole("img", { name: "Agent is responding" })).toBeNull();
      expect(screen.queryByRole("img", { name: "Awaiting input" })).toBeNull();
    }
  });

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
    expect(screen.getByTestId("message-optimistic-1").textContent).toContain("Pending answer");

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

  test("streams canonical reasoning in a folded preview and resets it to the beginning when complete", () => {
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
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByTestId("execution-reasoning-content")).toBeNull();
    const preview = within(reasoning).getByTestId("execution-reasoning-preview");
    expect(preview.textContent).toBe("Inspecting the workspace.");
    Object.defineProperty(preview, "scrollWidth", { configurable: true, value: 120 });

    const streamedStep = { ...reasoningStep, summary: "Inspecting the workspace.\nChecking the tests." };
    rerender(view(streamedStep));
    expect(preview.scrollLeft).toBe(120);
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
    expect(preview.scrollLeft).toBe(0);

    fireEvent.click(completedToggle);
    const reopenedContent = within(reasoning).getByTestId("execution-reasoning-content");
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
