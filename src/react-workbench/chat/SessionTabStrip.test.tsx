// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";

afterEach(cleanup);

const tabs: SessionTabItem[] = Array.from({ length: 5 }, (_, index) => ({
  id: `session-${index}`,
  status: "idle",
  title: `Conversation ${index + 1}`,
  unread: false,
}));

function renderTabStrip() {
  render(
    <SessionTabStrip
      activeSessionId={tabs[0].id}
      tabs={tabs}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCreate={vi.fn()}
    />,
  );

  const tablist = screen.getByRole("tablist", { name: "Open conversations" });
  Object.defineProperties(tablist, {
    clientWidth: { configurable: true, value: 300 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 900 },
  });
  return tablist;
}

describe("SessionTabStrip", () => {
  it("uses the mouse wheel to reveal horizontally overflowing tabs", () => {
    const tablist = renderTabStrip();
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });

    fireEvent(tablist, event);

    expect(tablist.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not trap vertical scrolling at the horizontal boundary", () => {
    const tablist = renderTabStrip();
    tablist.scrollLeft = 600;
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });

    fireEvent(tablist, event);

    expect(tablist.scrollLeft).toBe(600);
    expect(event.defaultPrevented).toBe(false);
  });
});
