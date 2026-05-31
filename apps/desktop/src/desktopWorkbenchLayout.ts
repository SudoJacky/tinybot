export type WorkbenchPanelId = "sidebar" | "inspector" | "bottom";

export interface WorkbenchPanelState {
  visible: boolean;
  size: number;
}

export interface WorkbenchLayoutState {
  sidebar: WorkbenchPanelState;
  inspector: WorkbenchPanelState;
  bottom: WorkbenchPanelState;
}

export interface LoadWorkbenchLayoutOptions {
  storage?: Pick<Storage, "getItem"> | null;
  viewportWidth?: number;
}

export const DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY = "tinybot.desktop.workbench.layout";

const DEFAULT_LAYOUT: WorkbenchLayoutState = {
  sidebar: { visible: true, size: 260 },
  inspector: { visible: true, size: 360 },
  bottom: { visible: false, size: 220 },
};

const PANEL_CONSTRAINTS: Record<WorkbenchPanelId, { min: number; max: number }> = {
  sidebar: { min: 220, max: 300 },
  inspector: { min: 280, max: 520 },
  bottom: { min: 160, max: 360 },
};

const NARROW_WORKBENCH_WIDTH = 1024;

export function createDefaultWorkbenchLayout(): WorkbenchLayoutState {
  return cloneLayout(DEFAULT_LAYOUT);
}

export function resizeWorkbenchPanel(
  layout: WorkbenchLayoutState,
  panel: WorkbenchPanelId,
  size: number,
): WorkbenchLayoutState {
  return {
    ...cloneLayout(layout),
    [panel]: {
      ...layout[panel],
      size: clampPanelSize(panel, size),
    },
  };
}

export function toggleWorkbenchPanel(
  layout: WorkbenchLayoutState,
  panel: WorkbenchPanelId,
  visible: boolean,
): WorkbenchLayoutState {
  return {
    ...cloneLayout(layout),
    [panel]: {
      ...layout[panel],
      visible,
    },
  };
}

export function persistWorkbenchLayout(
  layout: WorkbenchLayoutState,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeWorkbenchLayout(layout)));
}

export function loadWorkbenchLayout({
  storage = window.localStorage,
  viewportWidth = window.innerWidth,
}: LoadWorkbenchLayoutOptions = {}): WorkbenchLayoutState {
  const parsed = readStoredLayout(storage);
  return normalizeWorkbenchLayout(parsed ?? DEFAULT_LAYOUT, viewportWidth);
}

function readStoredLayout(storage: Pick<Storage, "getItem"> | null): unknown {
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeWorkbenchLayout(
  value: unknown,
  viewportWidth = Number.POSITIVE_INFINITY,
): WorkbenchLayoutState {
  const source = isPartialLayout(value) ? value : {};
  const layout: WorkbenchLayoutState = {
    sidebar: normalizePanel("sidebar", source.sidebar, DEFAULT_LAYOUT.sidebar),
    inspector: normalizePanel("inspector", source.inspector, DEFAULT_LAYOUT.inspector),
    bottom: normalizePanel("bottom", source.bottom, DEFAULT_LAYOUT.bottom),
  };

  if (viewportWidth < NARROW_WORKBENCH_WIDTH) {
    layout.inspector.visible = false;
    layout.bottom.visible = false;
  }

  return layout;
}

function normalizePanel(
  panel: WorkbenchPanelId,
  value: unknown,
  fallback: WorkbenchPanelState,
): WorkbenchPanelState {
  if (!isPartialPanel(value)) {
    return { ...fallback };
  }

  return {
    visible: typeof value.visible === "boolean" ? value.visible : fallback.visible,
    size: clampPanelSize(panel, typeof value.size === "number" ? value.size : fallback.size),
  };
}

function isPartialLayout(value: unknown): value is Partial<Record<WorkbenchPanelId, unknown>> {
  return value !== null && typeof value === "object";
}

function isPartialPanel(value: unknown): value is Partial<WorkbenchPanelState> {
  return value !== null && typeof value === "object";
}

function clampPanelSize(panel: WorkbenchPanelId, size: number): number {
  const constraints = PANEL_CONSTRAINTS[panel];
  return Math.min(constraints.max, Math.max(constraints.min, Math.round(size)));
}

function cloneLayout(layout: WorkbenchLayoutState): WorkbenchLayoutState {
  return {
    sidebar: { ...layout.sidebar },
    inspector: { ...layout.inspector },
    bottom: { ...layout.bottom },
  };
}
