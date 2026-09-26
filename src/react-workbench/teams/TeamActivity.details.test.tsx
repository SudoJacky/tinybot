// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStep } from "../../app-core/chat/chatTurnContracts";
import { TeamActivity } from "./TeamActivity";
import { projectTeamActivity } from "./useTeamActivity";

afterEach(cleanup);

function activity(steps: Array<Partial<ChatStep>>) {
  const snapshot: ChatTimelineSnapshot = {
    schemaVersion: "tinybot.chat_timeline.v1", sessionId: "worker", source: "canonical", turnRevisions: {}, diagnostics: [],
    turns: [{ id: "turn", sessionKey: "worker", status: "running", startedAt: "", updatedAt: "", userMessageId: "user",
      userMessage: { id: "user", role: "user", text: "Worker assignment", timestamp: "" },
      steps: steps.map((step, index) => ({ id: String(index), kind: "message", title: "Activity", sequence: index,
        status: "completed", agentContext: { id: "worker", title: "Researcher", type: "team" }, ...step })),
    }],
  };
  return { items: projectTeamActivity(snapshot, "turn"), loading: false };
}

const props = { threadId: "worker", workspacePath: "/workspace", workspaceStore: { readThreadFile: vi.fn() },
  onRefresh: vi.fn(), onViewChange: vi.fn() };

it("keeps structured results from tools without a dedicated renderer inspectable", () => {
  render(<TeamActivity {...props} activity={activity([
    { kind: "tool_call", toolCall: { id: "lookup", name: "lookup_projects", argsJson: { query: "agents" },
      resultJson: { projects: [{ name: "Tinybot", verified: true }] } } },
  ])} />);
  fireEvent.click(screen.getByRole("button", { name: /Toggle details for/ }));
  expect(screen.getByText(/"query": "agents"/)).toBeVisible();
  expect(screen.getByText(/"name": "Tinybot"/)).toBeVisible();
});

it("renders recorded reasoning, full command output, plan details and messages in execution order", () => {
  const stdout = Array.from({ length: 12 }, (_, index) => `Result ${index + 1}`).join("\n");
  const { container } = render(<TeamActivity {...props} activity={activity([
    { kind: "reasoning", summary: "Compare the two recorded sources.", startedAt: "2026-09-25T00:00:00Z", completedAt: "2026-09-25T00:00:02Z" },
    { kind: "tool_call", toolCall: { id: "command", name: "exec_command", argsJson: { command: "python collect.py" },
      resultJson: { raw: { stdout, exitCode: 0 } }, durationMs: 1200 } },
    { kind: "plan", title: "Review sources", plan: { completed: 1, total: 2, explanation: "Cross-check the results",
      steps: [{ step: "Collect sources", status: "completed" }, { step: "Verify counts", status: "in_progress" }] } },
    { kind: "message", summary: "Verified report with [source file](./report.md)." },
  ])} />);
  expect([...container.querySelectorAll(".team-work-event")].map(node => node.className)).toEqual([
    "team-work-event is-reasoning", "team-work-event is-tool_call", "team-work-event is-plan", "team-work-event is-message",
  ]);
  expect(screen.queryByText("Worker assignment")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Thought for 2/ }));
  expect(screen.getByText("Compare the two recorded sources.")).toBeVisible();
  const command = screen.getByRole("button", { name: "Toggle details for Ran python collect.py" });
  expect(command).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(command);
  expect(screen.getByText("python collect.py", { selector: "pre" })).toBeVisible();
  expect(screen.queryByText(/Result 12/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show full content" }));
  expect(screen.getByText(/Result 12/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(screen.queryByText(/Result 12/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Review sources/ }));
  expect(screen.getByText("Cross-check the results")).toBeVisible();
  expect(screen.getByText(/Verify counts/)).toBeVisible();
  expect(screen.getByText(/Verified report/)).toBeVisible();
});

it("updates streaming details in place and retains command errors", () => {
  const tool: Partial<ChatStep> = { kind: "tool_call", status: "running", toolCall: {
    id: "command", name: "exec_command", argsJson: { command: "cargo check" }, resultJson: { stdout: "Checking crate" },
  } };
  const { rerender } = render(<TeamActivity {...props} activity={activity([
    { kind: "reasoning", status: "running", summary: "Checking the build" }, tool,
  ])} />);
  expect(screen.getByText("Checking the build")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Toggle details for/ }));
  expect(screen.getByText("Checking crate")).toBeVisible();
  rerender(<TeamActivity {...props} activity={activity([
    { kind: "reasoning", status: "completed", summary: "Checking the build finished" },
    { ...tool, status: "failed", toolCall: { ...tool.toolCall!, resultJson: { stderr: "error[E0308]: mismatched types" } } },
  ])} />);
  expect(screen.getByRole("button", { name: "Toggle details for Command failed" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("error[E0308]: mismatched types")).toBeVisible();
  expect(screen.queryByText("Checking the build finished")).toBeNull();
});
