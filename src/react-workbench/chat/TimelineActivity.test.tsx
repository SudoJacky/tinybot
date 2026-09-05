// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineActivity } from "./TimelineActivity";

afterEach(cleanup);

describe("TimelineActivity", () => {
  it("links each trigger to its own details and supports mouse and keyboard toggles", async () => {
    const user = userEvent.setup();
    render(<>
      <TimelineActivity icon={<span>A</span>} title="First">First details</TimelineActivity>
      <TimelineActivity icon={<span>B</span>} title="Second">Second details</TimelineActivity>
    </>);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(first.getAttribute("aria-controls")).not.toBe(second.getAttribute("aria-controls"));
    expect(screen.queryByText("First details")).toBeNull();
    await user.click(first);
    const region = screen.getByRole("region", { name: "First" });
    expect(region.id).toBe(first.getAttribute("aria-controls"));
    expect(region).toHaveTextContent("First details");
    expect(second).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(first).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-expanded", "true");
  });

  it("lets a controlled caller decide when an expansion request takes effect", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = (open: boolean) => <TimelineActivity icon={null} onOpenChange={onOpenChange} open={open} title="Controlled">Details</TimelineActivity>;
    const { rerender } = render(view(false));
    const trigger = screen.getByRole("button", { name: "Controlled" });
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    rerender(view(true));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    rerender(view(false));
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("does not offer expansion for an item without details", () => {
    render(<TimelineActivity defaultOpen icon={null} title="No details">{[null, false]}</TimelineActivity>);
    expect(screen.getByText("No details")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region", { hidden: true })).toBeNull();
  });

  it("preserves mounted detail state while keeping it inaccessible when collapsed", async () => {
    const user = userEvent.setup();
    render(<TimelineActivity defaultOpen icon={null} keepMounted title="Editor"><input aria-label="Draft" /></TimelineActivity>);
    const trigger = screen.getByRole("button", { name: "Editor" });
    const input = screen.getByRole("textbox", { name: "Draft" });
    await user.type(input, "Saved draft");
    await user.click(trigger);
    expect(input).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveValue("Saved draft");
  });

  it("preserves child disclosure choices when a containing activity is folded", async () => {
    const user = userEvent.setup();
    render(<TimelineActivity defaultOpen icon={null} keepMounted title="Trace">
      <TimelineActivity icon={null} title="Tool">Tool details</TimelineActivity>
    </TimelineActivity>);
    const trace = screen.getByRole("button", { name: "Trace" });
    const tool = screen.getByRole("button", { name: "Tool" });
    await user.click(tool);
    await user.click(trace);
    expect(screen.queryByRole("button", { name: "Tool" })).toBeNull();
    await user.click(trace);
    expect(screen.getByRole("button", { name: "Tool" })).toBe(tool);
    expect(tool).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Tool" })).toHaveTextContent("Tool details");
  });

  it("hides the collapsed preview on expansion and keeps the summary outside the trigger", async () => {
    const user = userEvent.setup();
    render(<TimelineActivity
      icon={null}
      preview={<span>Latest text</span>}
      summary={<progress aria-label="Progress" max={2} value={1} />}
      title="Activity"
      triggerLabel="Toggle activity"
    >Full details</TimelineActivity>);
    const trigger = screen.getByRole("button", { name: "Toggle activity" });
    const preview = screen.getByText("Latest text");
    const progress = screen.getByRole("progressbar", { name: "Progress" });
    expect(preview).toBeVisible();
    expect(trigger).not.toContainElement(progress);
    await user.click(trigger);
    expect(preview).not.toBeVisible();
    expect(progress).toBeVisible();
    await user.click(trigger);
    expect(preview).toBeVisible();
    expect(progress).toBeVisible();
  });
});
