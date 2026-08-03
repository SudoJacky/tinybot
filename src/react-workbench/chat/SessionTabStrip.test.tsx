// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabs: SessionTabItem[] = Array.from({ length: 5 }, (_, index) => ({
  id: `session-${index}`,
  status: "idle",
  title: `Conversation ${index + 1}`,
  unread: false,
}));

function tabStrip(activeSessionId = tabs[0].id) {
  return (
    <SessionTabStrip
      activeSessionId={activeSessionId}
      tabs={tabs}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCreate={vi.fn()}
    />
  );
}

function renderTabStrip() {
  render(tabStrip());

  const tablist = screen.getByRole("tablist", { name: "Open conversations" });
  Object.defineProperties(tablist, {
    clientWidth: { configurable: true, value: 300 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 900 },
  });
  return tablist;
}

describe("SessionTabStrip", () => {
  it("reveals a tab when it becomes active", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(tabStrip());
    scrollIntoView.mockClear();

    rerender(tabStrip(tabs[4].id));

    const activeTab = screen.getByRole("tab", { name: tabs[4].title });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollIntoView.mock.instances[0]).toBe(activeTab);
  });

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
