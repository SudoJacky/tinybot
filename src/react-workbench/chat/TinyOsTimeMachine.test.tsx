// @vitest-environment happy-dom

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendAgentTurnItem } from "../../app-core/chat/chatRunModel";
import { createTinyOsTimeMachineIndex } from "../../app-core/chat/tinyOsTimeMachine";
import { TinyOsTimeMachine } from "./TinyOsTimeMachine";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function item(eventIndex: number, overrides: Partial<BackendAgentTurnItem> = {}): BackendAgentTurnItem {
  return {
    schemaVersion: "tinybot.turn_item.v2",
    createdAt: `2026-07-14T00:00:0${eventIndex}Z`,
    data: {
      args: {},
      name: "workspace.read_file",
      result: {},
      status: "completed",
      timing: {},
      toolCallId: `call-${eventIndex}`,
      type: "tool_call",
    },
    itemId: `item-${eventIndex}`,
    kind: "tool_call",
    revision: 1,
    runId: "run-1",
    sequence: eventIndex,
    sessionId: "session-1",
    status: "completed",
    title: `Event ${eventIndex + 1}`,
    turnId: eventIndex < 2 ? "turn-1" : "turn-2",
    ...overrides,
  };
}

describe("TinyOS Time Machine", () => {
  it("always allows an empty historical view to return to Live", () => {
    const onReturnToLive = vi.fn();
    render(<TinyOsTimeMachine currentEventIndex={0} index={createTinyOsTimeMachineIndex([])} live={false} onReturnToLive={onReturnToLive} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Return to Live" }));
    expect(onReturnToLive).toHaveBeenCalledTimes(1);
  });

  it("exposes native keyboard scrubbing, event groups, and unavailable wall-clock state", () => {
    const index = createTinyOsTimeMachineIndex([item(0, { createdAt: "invalid" }), item(1), item(2)]);
    const onSelect = vi.fn();
    render(<TinyOsTimeMachine currentEventIndex={0} index={index} live={false} onReturnToLive={vi.fn()} onSelect={onSelect} />);

    const scrubber = screen.getByRole("slider", { name: "Canonical event boundary" });
    expect(scrubber.getAttribute("type")).toBe("range");
    expect(screen.getByText("Wall-clock time unavailable")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.change(scrubber, { target: { value: "1" } });
    expect(onSelect).toHaveBeenCalledWith(index.boundaries[1]);
    fireEvent.click(screen.getByRole("button", { name: /turn turn-2/i }));
    expect(onSelect).toHaveBeenLastCalledWith(index.boundaries[2]);
  });

  it("plays locally at the selected speed and visits only canonical boundaries", () => {
    vi.useFakeTimers();
    const index = createTinyOsTimeMachineIndex([item(0), item(1), item(2)]);
    const visited: number[] = [];

    function Harness() {
      const [currentEventIndex, setCurrentEventIndex] = useState(0);
      return <TinyOsTimeMachine
        currentEventIndex={currentEventIndex}
        index={index}
        live={false}
        onReturnToLive={vi.fn()}
        onSelect={(boundary) => {
          visited.push(boundary.eventIndex);
          setCurrentEventIndex(boundary.eventIndex);
        }}
      />;
    }

    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Replay speed" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Play historical replay" }));
    act(() => vi.advanceTimersByTime(200));
    act(() => vi.advanceTimersByTime(200));

    expect(visited).toEqual([1, 2]);
    expect(screen.getByText("Event 3 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play historical replay" }).hasAttribute("disabled")).toBe(true);
  });
});
