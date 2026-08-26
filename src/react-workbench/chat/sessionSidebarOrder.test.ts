import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_SESSION_SIDEBAR_ORDER,
  SESSION_SIDEBAR_ORDER_STORAGE_KEY,
  orderSidebarItems,
  readSessionSidebarOrder,
  reorderSidebarItems,
  writeSessionSidebarOrder,
} from "./sessionSidebarOrder";

describe("sessionSidebarOrder", () => {
  it("reorders items inside one container without changing another container", () => {
    const reordered = reorderSidebarItems(INITIAL_SESSION_SIDEBAR_ORDER, {
      containerId: "workspace:tinybot",
      currentItemIds: ["one", "two", "three"],
      draggedItemId: "three",
      placement: "before",
      targetItemId: "one",
    });

    expect(reordered.itemIdsByContainer).toEqual({
      "workspace:tinybot": ["three", "one", "two"],
    });
    expect(orderSidebarItems(
      [{ id: "one" }, { id: "two" }],
      reordered,
      "workspace:other",
      (item) => item.id,
    )).toEqual([{ id: "one" }, { id: "two" }]);
  });

  it("puts newly discovered items before a saved manual order and ignores removed ids", () => {
    const items = [{ id: "new" }, { id: "two" }, { id: "one" }];
    const ordered = orderSidebarItems(
      items,
      { itemIdsByContainer: { root: ["missing", "one", "two"] } },
      "root",
      (item) => item.id,
    );

    expect(ordered.map((item) => item.id)).toEqual(["new", "one", "two"]);
  });

  it("round-trips versioned storage and diagnoses invalid saved state", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    const order = { itemIdsByContainer: { root: ["workspace:b", "workspace:a"] } };

    writeSessionSidebarOrder(adapter, order);
    expect(readSessionSidebarOrder(adapter)).toEqual(order);

    storage.set(SESSION_SIDEBAR_ORDER_STORAGE_KEY, JSON.stringify({ version: 2 }));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readSessionSidebarOrder(adapter)).toBe(INITIAL_SESSION_SIDEBAR_ORDER);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[session-sidebar-order] Failed to restore the saved order.",
      expect.any(Error),
    );
  });
});
