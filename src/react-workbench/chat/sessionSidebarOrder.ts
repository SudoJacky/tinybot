export const SESSION_SIDEBAR_ORDER_STORAGE_KEY = "tinybot.ui.chat.sidebar-order.v1";

export type SessionSidebarOrder = {
  itemIdsByContainer: Record<string, string[]>;
};

export const INITIAL_SESSION_SIDEBAR_ORDER: SessionSidebarOrder = {
  itemIdsByContainer: {},
};

type StoredSessionSidebarOrder = SessionSidebarOrder & {
  version: 1;
};

export function orderSidebarItems<T>(
  items: readonly T[],
  order: SessionSidebarOrder,
  containerId: string,
  itemId: (item: T) => string,
): T[] {
  const byId = new Map(items.map((item) => [itemId(item), item]));
  return reconcileSidebarItemIds(
    items.map(itemId),
    order.itemIdsByContainer[containerId] ?? [],
  ).flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
}

export function reorderSidebarItems(
  order: SessionSidebarOrder,
  input: {
    containerId: string;
    currentItemIds: readonly string[];
    draggedItemId: string;
    placement: "after" | "before";
    targetItemId: string;
  },
): SessionSidebarOrder {
  const reconciled = reconcileSidebarItemIds(
    input.currentItemIds,
    order.itemIdsByContainer[input.containerId] ?? [],
  );
  if (
    input.draggedItemId === input.targetItemId
    || !reconciled.includes(input.draggedItemId)
    || !reconciled.includes(input.targetItemId)
  ) {
    return order;
  }

  const withoutDragged = reconciled.filter((id) => id !== input.draggedItemId);
  const targetIndex = withoutDragged.indexOf(input.targetItemId);
  const insertionIndex = targetIndex + (input.placement === "after" ? 1 : 0);
  const nextItemIds = [...withoutDragged];
  nextItemIds.splice(insertionIndex, 0, input.draggedItemId);
  if (nextItemIds.every((id, index) => id === reconciled[index])) {
    return order;
  }
  return {
    itemIdsByContainer: {
      ...order.itemIdsByContainer,
      [input.containerId]: nextItemIds,
    },
  };
}

export function readSessionSidebarOrder(
  storage: Pick<Storage, "getItem">,
): SessionSidebarOrder {
  try {
    const serialized = storage.getItem(SESSION_SIDEBAR_ORDER_STORAGE_KEY);
    if (!serialized) return INITIAL_SESSION_SIDEBAR_ORDER;
    const value = JSON.parse(serialized) as unknown;
    if (!isStoredSessionSidebarOrder(value)) {
      throw new Error("Stored session sidebar order has an invalid shape.");
    }
    return { itemIdsByContainer: value.itemIdsByContainer };
  } catch (error) {
    console.warn("[session-sidebar-order] Failed to restore the saved order.", error);
    return INITIAL_SESSION_SIDEBAR_ORDER;
  }
}

export function writeSessionSidebarOrder(
  storage: Pick<Storage, "setItem">,
  order: SessionSidebarOrder,
): void {
  const stored: StoredSessionSidebarOrder = {
    version: 1,
    itemIdsByContainer: order.itemIdsByContainer,
  };
  storage.setItem(SESSION_SIDEBAR_ORDER_STORAGE_KEY, JSON.stringify(stored));
}

function reconcileSidebarItemIds(
  currentItemIds: readonly string[],
  preferredItemIds: readonly string[],
): string[] {
  const current = new Set(currentItemIds);
  const preferredSet = new Set<string>();
  const preferred = preferredItemIds.filter((id) => {
    if (!current.has(id) || preferredSet.has(id)) return false;
    preferredSet.add(id);
    return true;
  });
  const newItemSet = new Set<string>();
  const newItems = currentItemIds.filter((id) => {
    if (preferredSet.has(id) || newItemSet.has(id)) return false;
    newItemSet.add(id);
    return true;
  });
  return [...newItems, ...preferred];
}

function isStoredSessionSidebarOrder(value: unknown): value is StoredSessionSidebarOrder {
  return isRecord(value)
    && value.version === 1
    && isRecord(value.itemIdsByContainer)
    && Object.values(value.itemIdsByContainer).every((ids) => (
      Array.isArray(ids) && ids.every((id) => typeof id === "string")
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
