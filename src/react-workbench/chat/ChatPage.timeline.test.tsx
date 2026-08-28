// @vitest-environment happy-dom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatEvent } from "../services";
import type { ReactChatMessage } from "./messageActions";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  failedPlanTimeline,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
  it("shows branch on a completed tool-backed final answer but not on user or commentary messages", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const userMessage = await screen.findByTestId("message-u1");
    expect(within(userMessage).queryByRole("button", { name: /branch from here/i })).toBeNull();

    expect(within(screen.getByTestId("message-a1")).queryByRole("button", { name: /branch from here/i })).toBeNull();
    expect(within(screen.getByTestId("message-a2")).getByRole("button", { name: /branch from here/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Agent steps, 1 step/i }));
    expect(screen.getByRole("button", { name: /open details for shell/i })).toBeTruthy();
  });

  it("hides copy and branch actions for reasoning-only assistant messages", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const reasoningOnlyMessages: ReactChatMessage[] = [
      {
        id: "a-thinking",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "",
        reasoningText: "Checking the current workspace before answering.",
        status: "complete",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, reasoningOnlyMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-thinking");
    const reasoning = within(message).getByLabelText("Reasoning");
    const reasoningToggle = within(reasoning).getByRole("button", { name: "Reasoning" });
    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByText("Checking the current workspace before answering.")).toBeNull();

    await user.click(reasoningToggle);

    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(reasoning).getByText("Checking the current workspace before answering.")).toBeTruthy();

    await user.click(reasoningToggle);

    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(reasoning).queryByText("Checking the current workspace before answering.")).toBeNull();
    expect(within(message).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(message).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(message.querySelector(".react-message__actions")).toBeNull();
  });

  it("expands live thinking and collapses it when the message completes", async () => {
    let subscribed: ((event: ChatEvent) => void) | undefined;
    const stores = createStores();
    const liveMessage: ReactChatMessage = {
      id: "a-live-thinking",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "",
      reasoningText: "Inspecting the workspace.",
      status: "streaming",
    };
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [liveMessage]));
    stores.chatStore.subscribe = vi.fn((_sessionId, listener) => {
      subscribed = listener;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-live-thinking");
    const reasoning = within(message).getByLabelText("Reasoning");
    const reasoningToggle = within(reasoning).getByRole("button", { name: "Thinking" });
    expect(reasoningToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(reasoning).getByText("Inspecting the workspace.")).toBeTruthy();

    act(() => {
      subscribed?.({
        type: "timeline.patch",
        timeline: timelineFromReactMessages("s1", [{ ...liveMessage, status: "complete" }]),
      });
    });

    await waitFor(() => expect(reasoningToggle.getAttribute("aria-expanded")).toBe("false"));
    expect(within(reasoning).queryByText("Inspecting the workspace.")).toBeNull();
  });

  it("hides assistant copy and branch actions until the turn completes", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const midTurnMessages: ReactChatMessage[] = [
      {
        id: "a-mid-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Partial body that arrived before the turn completed.",
        status: "complete",
        turnStatus: "running",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, midTurnMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const message = await screen.findByTestId("message-a-mid-turn");
    expect(within(message).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(message).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(message.querySelector(".react-message__actions")).toBeNull();
  });

  it("keeps actions on completed turn messages while a later turn is running", async () => {
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Planning notes",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "running",
      }],
    });
    const turnScopedMessages: ReactChatMessage[] = [
      {
        id: "a-completed-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
        text: "Final answer from the previous turn.",
        status: "complete",
        turnId: "turn-1",
        turnStatus: "completed",
      },
      {
        id: "a-running-turn",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Current turn body before the turn is done.",
        status: "complete",
        turnId: "turn-2",
        turnStatus: "running",
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, turnScopedMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const completedMessage = await screen.findByTestId("message-a-completed-turn");
    expect(within(completedMessage).getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(within(completedMessage).getByRole("button", { name: "Branch from here" })).toBeTruthy();

    const runningMessage = await screen.findByTestId("message-a-running-turn");
    expect(within(runningMessage).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(runningMessage).queryByRole("button", { name: "Branch from here" })).toBeNull();
    expect(runningMessage.querySelector(".react-message__actions")).toBeNull();
  });

  it("renders tool activity as collapsible agent steps", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByTestId("message-a2");
    const stepsToggle = screen.getByRole("button", { name: /Agent steps, 1 step/i });
    expect(stepsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Agent steps" })).toBeNull();

    await user.click(stepsToggle);

    expect(stepsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "Agent steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details for shell" })).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("marks the current running agent step in the stepper", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const runningMessages: ReactChatMessage[] = [
      {
        id: "a-running",
        role: "assistant",
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Working through the task.",
        status: "complete",
        toolCalls: [
          { id: "tool-running", name: "workspace.read_file", status: "running", summary: "Reading current files" },
          { id: "tool-queued", name: "workspace.search", status: "queued", summary: "Waiting its turn" },
          { id: "tool-complete", name: "shell", status: "complete", summary: "Finished" },
        ],
      },
    ];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, runningMessages));

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByTestId("message-a-running");
    await user.click(screen.getByRole("button", { name: /Agent steps, 3 steps/i }));
    const stepper = document.querySelector(".react-agent-steps");
    const currentStep = document.querySelector(".react-agent-step-item[aria-current='step']") as HTMLElement | null;

    expect(stepper?.getAttribute("data-stepper")).toBe("true");
    expect(currentStep?.getAttribute("data-status")).toBe("active");
    expect(currentStep?.getAttribute("data-step-index")).toBe("0");
    expect(currentStep?.getAttribute("data-step-count")).toBe("3");
    expect(currentStep?.querySelector(".react-agent-step__status")?.textContent).toBe("In progress");
  });

  it("opens tool details in an animated right drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for shell" }));

    const drawer = screen.getByLabelText("Details drawer");
    expect(drawer.getAttribute("data-motion")).toBe("fade-content");
    expect(drawer.getAttribute("data-state")).toBe("open");
    expect(drawer.firstElementChild?.classList.contains("react-right-drawer__header")).toBe(true);
    expect(drawer.textContent).toContain("Done");
  });

  it("shows canonical tool arguments and result in the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const detailedMessages: ReactChatMessage[] = [{
      id: "a-tool-details",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "I checked the workspace.",
      status: "complete",
      toolCalls: [{
        argsText: "{\"path\":\"src/main.ts\"}",
        childTurnId: "child-turn-1",
        delegateId: "delegate-1",
        delegateTask: "Review implementation",
        delegateTitle: "Code reviewer",
        delegateType: "review",
        finalOutput: "Reviewed implementation.",
        id: "tool-1",
        name: "workspace.read_file",
        parentTurnId: "parent-turn-1",
        responseText: "file contents",
        sessionKey: "websocket:chat-1",
        status: "completed",
        summary: "Read src/main.ts",
        traceRef: "trace-1",
      } as NonNullable<ReactChatMessage["toolCalls"]>[number]],
    }];
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, detailedMessages));
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: /Agent steps, 1 step/i }));
    await user.click(await screen.findByRole("button", { name: "Open details for workspace.read_file" }));

    const drawer = screen.getByLabelText("Details drawer");
    expect(within(drawer).getByText("Arguments")).toBeTruthy();
    expect(drawer.textContent).toContain("{\"path\":\"src/main.ts\"}");
    expect(within(drawer).getByText("Response")).toBeTruthy();
    expect(drawer.textContent).toContain("file contents");
  });

  it("submits active agent-ui forms from the chat page", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      description: "Collect itinerary constraints before planning.",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: { chat_id: "chat-1", turn_id: "turn-1", session_id: "s1" },
      fields: [
        { name: "destination", type: "text", label: "Destination", required: true },
        { name: "nights", type: "number", label: "Nights", required: false, min: 1, max: 30 },
      ],
      values: { destination: "Shanghai", nights: 3 },
      errors: { destination: "Required" },
      status: "pending",
      chat_id: "chat-1",
    };
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].id = "turn-1";
    canonical.turns[0].status = "awaiting_user";
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: {
        errors: { destination: "Required" },
        fieldIds: ["destination", "nights"],
        formId: "travel-preferences-1",
      },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "blocked",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).listAgentUiForms = vi.fn(async () => [form]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const card = await screen.findByRole("form", { name: "Travel preferences" });
    expect(card.textContent).toContain("Collect itinerary constraints before planning.");
    expect(screen.getAllByText("Travel preferences")).toHaveLength(1);
    expect(within(card).getByRole("alert").textContent).toBe("Required");
    expect(within(card).getByLabelText("Destination").getAttribute("aria-invalid")).toBe("true");

    const destination = within(card).getByLabelText("Destination") as HTMLInputElement;
    const nights = within(card).getByLabelText("Nights") as HTMLInputElement;
    await user.clear(destination);
    await user.type(destination, "Singapore");
    await user.clear(nights);
    await user.type(nights, "4");
    expect(destination.value).toBe("Singapore");
    expect(nights.value).toBe("4");
    await user.click(within(card).getByRole("button", { name: "Save preferences" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      form: {
        formId: "travel-preferences-1",
        values: { destination: "Singapore", nights: 4 },
      },
      kind: "form.submit",
      source: { control: "chat-form", surface: "chat" },
      target: expect.objectContaining({ turnId: "turn-1", sessionId: "s1" }),
    }));
    expect(within(card).getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(true);
  });

  it("cancels active agent-ui forms through Thread command dispatch", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: { chat_id: "chat-1", turn_id: "turn-1", session_id: "s1" },
      fields: [{ name: "destination", type: "text", label: "Destination", required: true }],
      values: { destination: "Shanghai" },
      status: "pending",
      chat_id: "chat-1",
    };
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form-cancel",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].id = "turn-1";
    canonical.turns[0].status = "awaiting_user";
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: { fieldIds: ["destination"], formId: "travel-preferences-1" },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "blocked",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).listAgentUiForms = vi.fn(async () => [form]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const card = await screen.findByRole("form", { name: "Travel preferences" });
    await user.click(within(card).getByRole("button", { name: "Skip" }));

    expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      form: { formId: "travel-preferences-1" },
      kind: "form.cancel",
      source: { control: "chat-form", surface: "chat" },
      target: expect.objectContaining({ turnId: "turn-1", sessionId: "s1" }),
    }));
    expect(within(card).getByRole("button", { name: "Skip" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders a resolved canonical form as a read-only submission summary", async () => {
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-form-summary",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Plan my trip",
      status: "complete",
    }]);
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      form: {
        action: "submit",
        fieldIds: ["destination"],
        formId: "travel-preferences-1",
        values: { destination: "Singapore" },
      },
      id: "travel-preferences-1",
      kind: "form",
      sequence: 1,
      status: "completed",
      title: "Travel preferences",
    });
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const summary = await screen.findByRole("region", { name: "Travel preferences" });
    expect(summary.textContent).toContain("Submitted");
    expect(summary.textContent).toContain("destination");
    expect(summary.textContent).toContain("Singapore");
    expect(screen.queryByRole("form", { name: "Travel preferences" })).toBeNull();
  });

  it("opens the selected canonical subagent trace in the details drawer", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-subagent",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect the repository",
      status: "complete",
    }]);
    canonical.turns[0].steps.push({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      delegate: {
        id: "delegate-42",
        latestActivity: "Reading source files",
        status: "running",
        title: "Research agent",
        traceRef: "trace-delegate-42",
        type: "subagent",
      },
      id: "delegate-42",
      kind: "delegate",
      sequence: 1,
      status: "running",
      title: "Research agent",
    });
    const loadDelegateTrace = vi.fn(async () => ({
      trace: {
        delegateId: "delegate-42",
        status: "running",
        events: [{
          event_id: "trace-step-1",
          event_type: "child.tool.completed",
          created_at: "2026-07-04T12:01:01Z",
          payload: { status: "completed", title: "Inspect repository" },
        }],
      },
    }));
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).loadDelegateTrace = loadDelegateTrace;

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Open details for Research agent" }));
    expect(loadDelegateTrace).toHaveBeenCalledWith({
      delegateId: "delegate-42",
      sessionKey: "s1",
      traceRef: "trace-delegate-42",
    });
    const drawer = await screen.findByLabelText("Details drawer");
    await waitFor(() => expect(drawer.textContent).toContain("Inspect repository"));
    expect(drawer.textContent).toContain("delegate-42");
  });

  it("renders canonical plan progress and expandable compaction token details", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-plan",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Implement the timeline",
      status: "complete",
    }]);
    canonical.turns[0].steps.push(
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "plan-1",
        kind: "plan",
        plan: {
          completed: 1,
          currentStep: "Render progress",
          explanation: "Implementation order updated",
          steps: [
            { step: "Inspect model", status: "completed" },
            { step: "Render progress", status: "in_progress" },
            { step: "Run tests", status: "pending" },
          ],
          total: 3,
        },
        sequence: 1,
        status: "running",
        summary: "Canonical timeline rollout",
        title: "Plan 1/3",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        compaction: { droppedItemCount: 12, estimatedTokensAfter: 4200, estimatedTokensBefore: 12000 },
        id: "compaction-1",
        kind: "compaction",
        sequence: 2,
        status: "completed",
        summary: "compact",
        title: "Context compacted",
      },
    );
    stores.chatStore.load = vi.fn(async () => canonical);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const progress = await screen.findByRole("progressbar", { name: "Plan 1/3" });
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("3");
    expect(screen.getByText("Implementation order updated")).toBeTruthy();
    expect(screen.getByText("Inspect model").closest("li")?.getAttribute("data-status")).toBe("completed");
    expect(screen.getByText("Render progress")).toBeTruthy();
    expect(screen.getByText("Run tests").closest("li")?.getAttribute("data-status")).toBe("pending");
    await user.click(screen.getByText("Context compacted"));
    const compaction = screen.getByText("Before: 12,000 tokens").closest("details");
    expect(compaction?.textContent).toContain("After: 4,200 tokens");
    expect(compaction?.textContent).toContain("Dropped items: 12");
  });

  it("coalesces multiple running timeline patches into one animation-frame commit", async () => {
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    let frame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 7;
    });
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });
    const streamingTimeline = (text: string) => timelineFromReactMessages("s1", [{
      id: "u-stream-frame",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      text: "Stream",
      status: "complete" as const,
    }, {
      id: "a-stream-frame",
      role: "assistant" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 1),
      text,
      status: "streaming" as const,
      turnStatus: "running" as const,
    }]);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);
    expect(await screen.findByText("Yes.")).toBeTruthy();

    act(() => {
      listener?.({ type: "timeline.patch", timeline: streamingTimeline("A") });
      listener?.({ type: "timeline.patch", timeline: streamingTimeline("AB") });
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("AB")).toBeNull();
    act(() => frame?.(0));
    expect(await screen.findByText("AB")).toBeTruthy();
    requestFrame.mockRestore();
  });

  it("renders Plan first and shows failures as a lightweight inline error", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const plan = await screen.findByRole("region", { name: "Execution plan" });
    const planToggle = within(plan).getByRole("button", { name: /Execution plan/ });
    const details = screen.getByRole("button", { name: /Agent steps, 1 step/i });
    const error = screen.getByRole("alert", { name: "Task execution failed" });
    expect(plan.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(error));
    expect(planToggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(planToggle);
    expect(planToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(planToggle);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(error.textContent).toContain("Execution reached the iteration limit");
    expect(error.textContent).not.toContain("Read project files");
    expect(error.textContent).not.toContain("1 steps completed");
    expect(within(error).getByRole("button", { name: "Copy error" })).toBeTruthy();
    expect(within(error).queryByRole("button", { name: /Continue|Retry|Start over|View details/ })).toBeNull();
  });

  it("renders canonical execution items chronologically and restores completed turns folded", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-interleaved",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect and verify",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.status = "completed";
    turn.completedAt = new Date(Date.UTC(2026, 6, 4, 12, 1, 8)).toISOString();
    turn.steps = [
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "reasoning-0",
        kind: "reasoning",
        modelCallId: "call-0",
        sequence: 1,
        status: "completed",
        summary: "Inspect the first file.",
        title: "Thinking complete",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-0",
        kind: "message",
        messageId: "commentary-0",
        messagePhase: "commentary",
        modelCallId: "call-0",
        sequence: 2,
        status: "completed",
        summary: "I found the first file.",
        title: "Progress update",
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "tool-1",
        kind: "tool_call",
        sequence: 3,
        status: "completed",
        title: "workspace.read_file",
        toolCall: { id: "tool-1", name: "workspace.read_file", resultPreview: "Loaded" },
      },
      {
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-1",
        kind: "message",
        messageId: "commentary-1",
        messagePhase: "commentary",
        modelCallId: "call-1",
        sequence: 4,
        status: "completed",
        summary: "Now I will verify it.",
        title: "Progress update",
      },
    ];
    turn.executionItems = turn.steps;
    turn.finalAnswer = {
      id: "final-1",
      role: "assistant",
      text: "Verification passed.",
      timestamp: turn.completedAt,
    };
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed 4 actions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Verification passed.")).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const orderedItems = document.querySelectorAll(".react-execution-timeline__item");
    expect([...orderedItems].map((item) => item.getAttribute("data-kind"))).toEqual([
      "reasoning",
      "message",
      "tool_call",
      "message",
    ]);
    const toolItem = [...orderedItems].find((item) => item.getAttribute("data-kind") === "tool_call")!;
    expect(toolItem.querySelector(".react-agent-steps__header")).toBeNull();
    expect(toolItem.querySelector(".react-tool-activity")).not.toBeNull();
    expect(screen.getByText("I found the first file.")).toBeTruthy();
    expect(screen.getByText("Now I will verify it.")).toBeTruthy();
  });

  it("renders apply_patch tool results as an inline file diff", async () => {
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-patch-preview",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Update the parser",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "patch-1",
      kind: "tool_call",
      sequence: 1,
      status: "completed",
      title: "apply_patch",
      toolCall: {
        id: "patch-1",
        name: "apply_patch",
        resultJson: {
          result: {
            changed_files: [{
              path: "src/parser.rs",
              operation: "update",
              hunks: [{ index: 1, removed_lines: 1, added_lines: 1 }],
              delta: [{
                old_start: 44,
                new_start: 44,
                old_lines: ["let marker = line.trim();"],
                new_lines: ["let marker = line.trim_end();"],
              }],
              delta_truncated: false,
            }],
          },
        },
      },
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("region", { name: "Changes from apply_patch" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Diff for src/parser.rs" })).toBeTruthy();
    expect(screen.getByText("let marker = line.trim();")).toBeTruthy();
    expect(screen.getByText("let marker = line.trim_end();")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Open details for Edited parser.rs" })).toBeNull();
  });

  it("auto-folds untouched execution on final answer and preserves explicit user-open intent", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    const timelineFor = (completed: boolean, totalTokens?: number) => {
      const timeline = timelineFromReactMessages("s1", [{
        id: "u-live-timeline",
        role: "user" as const,
        createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
        text: "Inspect live",
        status: "complete" as const,
      }]);
      const turn = timeline.turns[0];
      turn.status = completed ? "completed" : "running";
      turn.steps = [{
        agentContext: { id: "main", title: "Tinybot", type: "main" },
        id: "commentary-live",
        kind: "message",
        messageId: "commentary-live",
        messagePhase: "commentary",
        modelCallId: "call-live",
        sequence: 1,
        status: "completed",
        summary: "Inspecting the workspace.",
        title: "Progress update",
      }];
      turn.executionItems = turn.steps;
      if (completed) {
        turn.completedAt = new Date(Date.UTC(2026, 6, 4, 12, 1, 2)).toISOString();
        turn.finalAnswer = {
          id: "final-live",
          role: "assistant",
          text: "Inspection complete.",
          timestamp: turn.completedAt,
        };
      }
      if (totalTokens) {
        turn.usage = { totalTokens };
      }
      return timeline;
    };
    stores.chatStore.load = vi.fn(async () => timelineFor(false));
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    let toggle = await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const conversation = document.querySelector<HTMLElement>(".react-conversation-view")!;
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, value: 800, writable: true },
    });
    const timelineRect = vi.spyOn(executionTimeline, "getBoundingClientRect").mockImplementation(() => ({
      bottom: toggle.getAttribute("aria-expanded") === "true" ? 400 : 50,
      height: toggle.getAttribute("aria-expanded") === "true" ? 400 : 50,
      left: 0,
      right: 760,
      top: 0,
      width: 760,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    const conversationRect = vi.spyOn(conversation, "getBoundingClientRect").mockImplementation(() => ({
      bottom: 600,
      height: 500,
      left: 0,
      right: 1_000,
      top: 100,
      width: 1_000,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    }));
    let animationFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrame = callback;
      return 1;
    });
    act(() => listener?.({ type: "timeline.patch", timeline: timelineFor(true) }));
    toggle = await screen.findByRole("button", { name: /Work performed 1 action/ });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    act(() => animationFrame?.(0));
    expect(conversation.scrollTop).toBe(450);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => listener?.({ type: "timeline.patch", timeline: timelineFor(true, 42) }));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    requestFrame.mockRestore();
    conversationRect.mockRestore();
    timelineRect.mockRestore();
  });

  it("does not reopen explicitly closed execution when the final answer arrives", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    let listener: ((event: ChatEvent) => void) | undefined;
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-user-closed",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Keep closed",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "commentary-user-closed",
      kind: "message",
      messagePhase: "commentary",
      modelCallId: "call-user-closed",
      sequence: 1,
      status: "completed",
      summary: "Working.",
      title: "Progress update",
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);
    stores.chatStore.subscribe = vi.fn((_sessionId, callback) => {
      listener = callback;
      return () => undefined;
    });

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    turn.status = "completed";
    turn.finalAnswer = {
      id: "final-user-closed",
      role: "assistant",
      text: "Done.",
      timestamp: new Date(Date.UTC(2026, 6, 4, 12, 1, 2)).toISOString(),
    };
    act(() => listener?.({ type: "timeline.patch", timeline: { ...timeline, turns: [{ ...turn }] } }));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });

  it("keeps abnormal canonical execution expanded with the inline error visible", async () => {
    const stores = createStores();
    const timeline = failedPlanTimeline();
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const toggle = await screen.findByRole("button", { name: /Work performed Failed · 3 actions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const error = screen.getByRole("alert", { name: "Task execution failed" });
    expect(within(error).getByRole("button", { name: "Copy error" })).toBeTruthy();
  });

  it("keeps interrupted work visible without rendering a failure recovery card", async () => {
    const stores = createStores();
    const timeline = failedPlanTimeline();
    timeline.turns[0].status = "interrupted";
    timeline.turns[0].executionItems = timeline.turns[0].steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("button", { name: /Work performed Interrupted/ })).toBeTruthy();
    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(screen.queryByRole("alert", { name: "Task execution failed" })).toBeNull();
  });

  it("copies contextual failure details from the inline error", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const stores = createStores();
    stores.chatStore.load = vi.fn(async () => failedPlanTimeline());

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    const error = await screen.findByRole("alert", { name: "Task execution failed" });
    await user.click(within(error).getByRole("button", { name: "Copy error" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Error code: max_iterations"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Interrupted at: Read project files"));
  });

  it("loads owner-associated image references through the artifact API before previewing", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    const canonical = timelineFromReactMessages("s1", [{
      id: "u-artifact",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Create a chart",
      status: "complete",
    }, {
      id: "a-artifact",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 1),
      text: "Chart complete",
      status: "complete",
      toolCalls: [{ id: "tool-chart", name: "chart.render", status: "complete", summary: "Chart rendered" }],
    }]);
    canonical.turns[0].steps[0].artifacts = [{
      fetchPath: "output/chart.png",
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      status: "completed",
      title: "chart.png",
    }];
    const loadArtifact = vi.fn(async () => ({
      artifact: {
        artifactId: "image-1",
        content: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        title: "chart.png",
      },
    }));
    stores.chatStore.load = vi.fn(async () => canonical);
    (stores.chatStore as any).loadArtifact = loadArtifact;

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await user.click(await screen.findByRole("button", { name: "Preview chart.png" }));
    expect(loadArtifact).toHaveBeenCalledWith({ artifactId: "image-1", sessionKey: "s1" });
    const sidecar = await screen.findByLabelText("Sidecar");
    const image = await within(sidecar).findByRole("img", { name: "chart.png" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("opens assistant workspace file links as contextual artifact tabs", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Tinybot workspace",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory: "D:\\Code\\py\\tinybot",
      }],
    });
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [{
      id: "a-file-link",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "See [the renderer entry](src/main.ts:12).",
      status: "complete",
    }]));
    const readThreadFile = vi.fn(async () => ({
      content: "import { mount } from './react-workbench/main';",
      contentType: "text" as const,
      lineEnd: 1,
      lineStart: 1,
      path: "src/main.ts",
      revision: "rev-1",
      sizeBytes: 48,
    }));

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 2, 0)}
        sessionStore={stores.sessionStore}
        workspaceStore={{ readThreadFile }}
      />,
    );

    await user.click(await screen.findByRole("link", { name: "the renderer entry" }));

    expect(readThreadFile).toHaveBeenCalledWith({ path: "src/main.ts", threadId: "s1" });
    const sidecar = await screen.findByLabelText("Sidecar");
    expect(within(sidecar).getByRole("tab", { name: "main.ts" })).toBeTruthy();
    expect(await within(sidecar).findByText("import { mount } from './react-workbench/main';")).toBeTruthy();
  });

  it("surfaces truncated and binary workspace file previews in the artifact tab", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Tinybot workspace",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory: "D:\\Code\\py\\tinybot",
      }],
    });
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [{
      id: "a-file-preview-boundaries",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect [the full log](logs/full.log) or [the executable](dist/tinybot.exe).",
      status: "complete",
    }]));
    const readThreadFile = vi.fn(async ({ path }: { path: string }) => path.endsWith(".exe")
      ? {
          contentType: "binary" as const,
          path,
          revision: "rev-binary",
          sizeBytes: 1024,
        }
      : {
          content: "first chunk",
          contentType: "text" as const,
          lineEnd: 1,
          lineStart: 1,
          nextCursor: "cursor-2",
          path,
          revision: "rev-log",
          sizeBytes: 2048,
        });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 2, 0)}
        sessionStore={stores.sessionStore}
        workspaceStore={{ readThreadFile }}
      />,
    );

    await user.click(await screen.findByRole("link", { name: "the full log" }));
    let sidecar = await screen.findByLabelText("Sidecar");
    expect(await within(sidecar).findByText("first chunk")).toBeTruthy();
    expect(within(sidecar).getByText(/Preview truncated/)).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "the executable" }));
    sidecar = await screen.findByLabelText("Sidecar");
    await waitFor(() => {
      expect(within(sidecar).getByRole("alert").textContent).toContain("Binary files cannot be previewed");
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[artifact-preview] workspace file read failed",
      expect.objectContaining({ path: "dist/tinybot.exe", sessionId: "s1" }),
    );
    consoleError.mockRestore();
  });

  it("shows workspace file preview failures inside the artifact tab", async () => {
    const user = userEvent.setup();
    const stores = createStores({
      sessions: [{
        id: "s1",
        chatId: "chat-1",
        title: "Tinybot workspace",
        updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
        status: "idle",
        workingDirectory: "D:\\Code\\py\\tinybot",
      }],
    });
    stores.chatStore.load = vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, [{
      id: "a-bad-file-link",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "See [private file](C:/Users/private.txt).",
      status: "complete",
    }]));
    const readThreadFile = vi.fn();

    render(
      <ChatPage
        chatStore={stores.chatStore}
        now={() => Date.UTC(2026, 6, 4, 12, 2, 0)}
        sessionStore={stores.sessionStore}
        workspaceStore={{ readThreadFile }}
      />,
    );

    await user.click(await screen.findByRole("link", { name: "private file" }));

    const sidecar = await screen.findByLabelText("Sidecar");
    expect(within(sidecar).getByRole("alert").textContent).toContain("outside the active workspace");
    expect(readThreadFile).not.toHaveBeenCalled();
  });
});
