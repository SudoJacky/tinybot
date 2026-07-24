// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TinyOsKernelSnapshot, TinyOsProcess } from "../../app-core/chat/tinyOsKernelModel";
import { TinyOsSystemMonitor, tinyOsSystemMonitorRows, type TinyOsSystemMonitorControls } from "./TinyOsSystemMonitor";

afterEach(cleanup);

function process(overrides: Partial<TinyOsProcess> & Pick<TinyOsProcess, "id" | "kind" | "state" | "title">): TinyOsProcess {
  return {
    correlation: { sessionId: "session-1", turnId: "turn-1" },
    provenance: { kind: "canonical_event", revision: 1, sourceId: overrides.id },
    ...overrides,
  };
}

function snapshot(): TinyOsKernelSnapshot {
  const turn = process({ id: "turn", kind: "agent_turn", state: "running", title: "Agent turn turn-1" });
  const tool = process({
    applicationId: "terminal",
    correlation: { itemId: "tool-1", sessionId: "session-1", toolCallId: "call-1", turnId: "turn-1" },
    id: "tool",
    kind: "tool_operation",
    parentProcessId: turn.id,
    provenance: { kind: "canonical_event", observedAt: "2026-07-14T00:00:00Z", revision: 2, sourceId: "tool-1" },
    state: "running",
    title: "Run tests",
  });
  const failed = process({
    id: "failed",
    kind: "subagent",
    ownerAgentId: "agent-child",
    parentProcessId: turn.id,
    state: "failed",
    title: "Review tests",
  });
  return {
    agentGroups: [],
    browserSessions: [],
    capabilities: [],
    cursor: { eventCount: 4, eventIndex: 3, mode: "live" },
    discrepancies: [],
    metrics: [],
    notifications: [],
    processes: [turn, tool, failed],
    resources: [{
      access: "execute",
      id: "terminal-resource",
      kind: "terminal_execution",
      provenance: { kind: "canonical_event", revision: 2, sourceId: "tool-1" },
      relatedProcessIds: [tool.id],
      title: "npm test",
    }],
    truth: "derived",
  };
}

function controls(overrides: Partial<TinyOsSystemMonitorControls> = {}): TinyOsSystemMonitorControls {
  return {
    activeTurnId: "turn-1",
    canCancelTurn: true,
    canPauseTurn: true,
    canResumeTurn: false,
    canRetryTurn: false,
    commandLifecycle: { stage: "idle" },
    history: false,
    inspectableItemIds: ["tool-1"],
    onCancelTurn: vi.fn(),
    onInspect: vi.fn(),
    onPauseTurn: vi.fn(),
    onResumeTurn: vi.fn(),
    onRetry: vi.fn(),
    onReveal: vi.fn(),
    resumeUnavailableReason: "The backend reports that this turn is not paused.",
    revealableApplicationIds: ["terminal"],
    ...overrides,
  };
}

describe("TinyOS System Monitor", () => {
  it("renders a process tree and truthful process details", async () => {
    const user = userEvent.setup();
    render(<TinyOsSystemMonitor snapshot={snapshot()} />);

    expect(screen.getByText("Processes").previousSibling?.textContent).toBe("3");
    await user.click(screen.getByRole("button", { name: /Run tests/ }));
    const details = screen.getByRole("complementary", { name: "Process details" });
    expect(within(details).getAllByText("tool-1")).toHaveLength(2);
    expect(within(details).getByText("Terminal")).toBeTruthy();
    expect(within(details).getByText("npm test")).toBeTruthy();
    expect(within(details).getByText(/Runtime metrics unavailable/)).toBeTruthy();
    expect(within(details).getByText(/does not estimate CPU/)).toBeTruthy();
  });

  it("filters by lifecycle, Agent, turn, operation, and application", async () => {
    const user = userEvent.setup();
    render(<TinyOsSystemMonitor snapshot={snapshot()} />);

    await user.click(screen.getByRole("button", { name: "List" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by state" }), "failed");
    expect(screen.getByRole("button", { name: /Review tests/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run tests/ })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by Agent" }), "agent-child");
    await user.type(screen.getByRole("searchbox", { name: "Search processes" }), "review");
    expect(screen.getByRole("button", { name: /Review tests/ })).toBeTruthy();
  });

  it("keeps source-backed ancestors in filtered tree view", () => {
    const processes = snapshot().processes;
    const rows = tinyOsSystemMonitorRows(processes, {
      agentId: "agent-child",
      applicationId: "",
      operationId: "",
      query: "",
      state: "failed",
      turnId: "turn-1",
    }, "tree");

    expect(rows.map((row) => [row.process.id, row.depth])).toEqual([
      ["turn", 0],
      ["failed", 1],
    ]);
  });

  it("routes only target-safe controls and exposes backend unavailability", async () => {
    const user = userEvent.setup();
    const monitorControls = controls();
    render(<TinyOsSystemMonitor controls={monitorControls} snapshot={snapshot()} />);

    await user.click(screen.getByRole("button", { name: "Pause turn" }));
    expect(monitorControls.onPauseTurn).toHaveBeenCalledTimes(1);
    const resume = screen.getByRole("button", { name: "Resume turn" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe("The backend reports that this turn is not paused.");

    await user.click(screen.getByRole("button", { name: /Run tests/ }));
    await user.click(screen.getByRole("button", { name: "Reveal app" }));
    await user.click(screen.getByRole("button", { name: "Inspect evidence" }));
    expect(monitorControls.onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: "tool" }));
    expect(monitorControls.onInspect).toHaveBeenCalledWith(expect.objectContaining({ id: "tool" }));
  });

  it("keeps acknowledgement timeout visible and correlated to the selected turn", () => {
    render(<TinyOsSystemMonitor controls={controls({
      commandLifecycle: {
        command: {
          schemaVersion: "tinybot.command.v1",
          commandId: "command-1",
          issuedAt: "2026-07-14T00:00:00Z",
          kind: "agent.pause",
          source: { control: "system-monitor", surface: "tinyos" },
          target: { turnId: "turn-1", sessionId: "session-1" },
        },
        dispatchedAtMs: 1,
        error: "No canonical acknowledgement within 5000 ms",
        stage: "timed_out",
      },
    })} snapshot={snapshot()} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Acknowledgement timed out");
    expect(alert.textContent).toContain("No canonical acknowledgement within 5000 ms");
  });
});
