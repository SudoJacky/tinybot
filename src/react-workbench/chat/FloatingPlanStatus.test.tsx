// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanState } from "../../app-core/chat/chatTurnContracts";
import { FLOATING_PLAN_AUTO_COLLAPSE_MS, FloatingPlanStatus } from "./FloatingPlanStatus";

const plan: PlanState = {
  completed: 1,
  currentStep: "Implement the floating note",
  explanation: "Keep task progress visible while the conversation continues.",
  steps: [
    { status: "completed", step: "Inspect the canonical plan" },
    { status: "in_progress", step: "Implement the floating note" },
    { status: "pending", step: "Verify the interaction" },
  ],
  total: 3,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FloatingPlanStatus", () => {
  it("auto-collapses, then lets the user toggle the capsule", () => {
    vi.useFakeTimers();
    render(<FloatingPlanStatus identityKey="turn-1:plan-1" plan={plan} revisionKey="revision-1" />);

    expect(screen.getByRole("region", { name: "Task progress" }).getAttribute("aria-live")).toBe("polite");
    act(() => vi.advanceTimersByTime(FLOATING_PLAN_AUTO_COLLAPSE_MS));

    const capsule = screen.getByRole("button", { name: /Expand task progress/ });
    expect(capsule.textContent).toContain("1/3");
    fireEvent.click(capsule);

    const note = screen.getByRole("region", { name: "Task progress" });
    expect(within(note).getByText("Implement the floating note")).toBeTruthy();
    fireEvent.click(within(note).getByRole("button", { name: /Collapse task progress/ }));
    expect(screen.getByRole("button", { name: /Expand task progress/ })).toBeTruthy();
  });

  it("reopens a collapsed note on updates but preserves a manual expansion", () => {
    vi.useFakeTimers();
    const view = render(
      <FloatingPlanStatus identityKey="turn-1:plan-1" plan={plan} revisionKey="revision-1" />,
    );
    act(() => vi.advanceTimersByTime(FLOATING_PLAN_AUTO_COLLAPSE_MS));

    const updatedPlan: PlanState = {
      ...plan,
      completed: 2,
      currentStep: "Verify the interaction",
      steps: [
        { status: "completed", step: "Inspect the canonical plan" },
        { status: "completed", step: "Implement the floating note" },
        { status: "in_progress", step: "Verify the interaction" },
      ],
    };
    view.rerender(
      <FloatingPlanStatus identityKey="turn-1:plan-1" plan={updatedPlan} revisionKey="revision-2" />,
    );

    expect(screen.getByRole("region", { name: "Task progress" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(FLOATING_PLAN_AUTO_COLLAPSE_MS));
    fireEvent.click(screen.getByRole("button", { name: /Expand task progress/ }));

    view.rerender(
      <FloatingPlanStatus identityKey="turn-1:plan-1" plan={{ ...updatedPlan, explanation: "Updated again." }} revisionKey="revision-3" />,
    );
    act(() => vi.advanceTimersByTime(FLOATING_PLAN_AUTO_COLLAPSE_MS * 2));

    expect(screen.getByRole("region", { name: "Task progress" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Expand task progress/ })).toBeNull();
  });
});
