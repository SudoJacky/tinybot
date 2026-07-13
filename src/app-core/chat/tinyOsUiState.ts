import type { TinyOsAppId } from "./tinyOsDesktopModel";

export type TinyOsLayoutMode = "compact" | "workspace" | "expanded";

export type TinyOsDesktopBounds = {
  height: number;
  width: number;
};

export type TinyOsWindowRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type TinyOsWindowLayout = TinyOsWindowRect & {
  maximized: boolean;
  restoreRect?: TinyOsWindowRect;
};

export type TinyOsFileReference = {
  endLine?: number;
  path: string;
  provenance:
    | { kind: "canonical"; sourceItemId: string; turnId: string }
    | { kind: "workspace_read"; workspaceKey: string };
  revision?: string;
  selectedText?: string;
  startLine?: number;
};

export type TinyOsTerminalReference = {
  command: string;
  endLine?: number;
  sourceItemId: string;
  selectedText?: string;
  startLine?: number;
  turnId: string;
};

export type TinyOsPlanReference = {
  adjustment: string;
  sourceItemId: string;
  snapshotText: string;
  turnId: string;
};

export type TinyOsContextReference =
  | ({ kind: "file" } & TinyOsFileReference)
  | ({ kind: "terminal" } & TinyOsTerminalReference);

export type TinyOsAgentRequestReference = TinyOsContextReference | ({ kind: "plan" } & TinyOsPlanReference);
export type TinyOsAgentRequestIntent = "explain" | "modify" | "follow_up" | "adjust_plan";

export type TinyOsUiState = {
  activeTabs: Partial<Record<TinyOsAppId, string>>;
  bounds: TinyOsDesktopBounds;
  focusedAppId?: TinyOsAppId;
  inspectorItemIds: string[];
  layoutMode: TinyOsLayoutMode;
  minimizedAppIds: TinyOsAppId[];
  windowLayout: Partial<Record<TinyOsAppId, TinyOsWindowLayout>>;
  zOrder: TinyOsAppId[];
};

export type TinyOsUiAction =
  | { appId: TinyOsAppId; type: "focus" }
  | { appId: TinyOsAppId; type: "minimize" }
  | { appId: TinyOsAppId; type: "maximize_toggle" }
  | { appId: TinyOsAppId; rect: TinyOsWindowRect; type: "set_rect" }
  | { appId: TinyOsAppId; edge: "left" | "right"; type: "snap" }
  | { appId: TinyOsAppId; tabId: string; type: "set_active_tab" }
  | { itemId: string; type: "inspect" }
  | { itemId: string; type: "uninspect" }
  | { type: "reset" }
  | {
      appIds: TinyOsAppId[];
      bounds: TinyOsDesktopBounds;
      layoutMode: TinyOsLayoutMode;
      preferredActiveAppId?: TinyOsAppId;
      type: "sync";
    };

const MIN_WINDOW_WIDTH = 260;
const MIN_WINDOW_HEIGHT = 180;
const DESKTOP_INSET = 10;
const PERSISTENCE_VERSION = 1;
const STORAGE_PREFIX = "tinybot.tinyos.layout";

const APP_INDEX: Record<TinyOsAppId, number> = {
  files: 0,
  terminal: 1,
  browser: 2,
  plan: 3,
  memory: 4,
  subagents: 5,
  artifacts: 6,
  inspector: 7,
};

export function tinyOsLayoutModeForWidth(width: number, expanded = false): TinyOsLayoutMode {
  if (expanded) return "expanded";
  return width <= 520 ? "compact" : "workspace";
}

export function createTinyOsUiState(input: {
  appIds: TinyOsAppId[];
  bounds: TinyOsDesktopBounds;
  layoutMode: TinyOsLayoutMode;
  preferredActiveAppId?: TinyOsAppId;
  restoredLayout?: Partial<Record<TinyOsAppId, TinyOsWindowLayout>>;
}): TinyOsUiState {
  const bounds = normalizeBounds(input.bounds);
  const windowLayout = Object.fromEntries(input.appIds.map((appId) => [
    appId,
    normalizeWindowLayout(
      input.restoredLayout?.[appId] ?? defaultWindowLayout(appId, bounds, input.layoutMode),
      bounds,
    ),
  ])) as Partial<Record<TinyOsAppId, TinyOsWindowLayout>>;
  const focusedAppId = input.preferredActiveAppId && input.appIds.includes(input.preferredActiveAppId)
    ? input.preferredActiveAppId
    : input.appIds[input.appIds.length - 1];
  return {
    activeTabs: {},
    bounds,
    focusedAppId,
    inspectorItemIds: [],
    layoutMode: input.layoutMode,
    minimizedAppIds: [],
    windowLayout,
    zOrder: focusOrder(input.appIds, focusedAppId),
  };
}

export function reduceTinyOsUiState(state: TinyOsUiState, action: TinyOsUiAction): TinyOsUiState {
  switch (action.type) {
    case "focus":
      return focusWindow(state, action.appId);
    case "minimize": {
      const minimizedAppIds = unique([...state.minimizedAppIds, action.appId]);
      const focusedAppId = state.focusedAppId === action.appId
        ? [...state.zOrder].reverse().find((appId) => !minimizedAppIds.includes(appId))
        : state.focusedAppId;
      return { ...state, focusedAppId, minimizedAppIds };
    }
    case "maximize_toggle": {
      const current = state.windowLayout[action.appId] ?? defaultWindowLayout(action.appId, state.bounds, state.layoutMode);
      const next = current.maximized && current.restoreRect
        ? { ...normalizeWindowLayout(current.restoreRect, state.bounds), maximized: false }
        : {
            ...desktopRect(state.bounds),
            maximized: true,
            restoreRect: stripWindowMetadata(current),
          };
      return focusWindow({
        ...state,
        windowLayout: { ...state.windowLayout, [action.appId]: next },
      }, action.appId);
    }
    case "set_rect":
      return focusWindow({
        ...state,
        windowLayout: {
          ...state.windowLayout,
          [action.appId]: { ...normalizeWindowLayout(action.rect, state.bounds), maximized: false },
        },
      }, action.appId);
    case "snap": {
      const availableWidth = Math.max(1, state.bounds.width - DESKTOP_INSET * 2);
      const width = Math.max(1, Math.floor(availableWidth / 2) - 3);
      const rect = normalizeWindowLayout({
        height: state.bounds.height - DESKTOP_INSET * 2,
        width,
        x: action.edge === "left" ? DESKTOP_INSET : state.bounds.width - DESKTOP_INSET - width,
        y: DESKTOP_INSET,
      }, state.bounds);
      return focusWindow({
        ...state,
        windowLayout: { ...state.windowLayout, [action.appId]: { ...rect, maximized: false } },
      }, action.appId);
    }
    case "set_active_tab":
      return { ...state, activeTabs: { ...state.activeTabs, [action.appId]: action.tabId } };
    case "inspect":
      return { ...state, inspectorItemIds: unique([...state.inspectorItemIds, action.itemId]).slice(-2) };
    case "uninspect":
      return { ...state, inspectorItemIds: state.inspectorItemIds.filter((itemId) => itemId !== action.itemId) };
    case "reset":
      return createTinyOsUiState({
        appIds: state.zOrder,
        bounds: state.bounds,
        layoutMode: state.layoutMode,
        preferredActiveAppId: state.focusedAppId,
      });
    case "sync": {
      const bounds = normalizeBounds(action.bounds);
      const modeChanged = action.layoutMode !== state.layoutMode;
      const windowLayout = Object.fromEntries(action.appIds.map((appId) => {
        const current = modeChanged ? undefined : state.windowLayout[appId];
        return [appId, normalizeWindowLayout(
          current ?? defaultWindowLayout(appId, bounds, action.layoutMode),
          bounds,
        )];
      })) as Partial<Record<TinyOsAppId, TinyOsWindowLayout>>;
      const minimizedAppIds = state.minimizedAppIds.filter((appId) => action.appIds.includes(appId));
      const requestedFocus = action.preferredActiveAppId && action.appIds.includes(action.preferredActiveAppId)
        ? action.preferredActiveAppId
        : state.focusedAppId;
      const focusedAppId = requestedFocus && action.appIds.includes(requestedFocus) && !minimizedAppIds.includes(requestedFocus)
        ? requestedFocus
        : [...action.appIds].reverse().find((appId) => !minimizedAppIds.includes(appId));
      return {
        ...state,
        bounds,
        focusedAppId,
        layoutMode: action.layoutMode,
        minimizedAppIds,
        windowLayout,
        zOrder: focusOrder(action.appIds, focusedAppId, state.zOrder),
      };
    }
  }
}

export function normalizeWindowLayout(
  value: TinyOsWindowRect | TinyOsWindowLayout,
  rawBounds: TinyOsDesktopBounds,
): TinyOsWindowLayout {
  const bounds = normalizeBounds(rawBounds);
  const maxWidth = Math.max(1, bounds.width - DESKTOP_INSET * 2);
  const maxHeight = Math.max(1, bounds.height - DESKTOP_INSET * 2);
  const width = clamp(finite(value.width, maxWidth), Math.min(MIN_WINDOW_WIDTH, maxWidth), maxWidth);
  const height = clamp(finite(value.height, maxHeight), Math.min(MIN_WINDOW_HEIGHT, maxHeight), maxHeight);
  return {
    height,
    maximized: "maximized" in value ? Boolean(value.maximized) : false,
    width,
    x: clamp(finite(value.x, DESKTOP_INSET), DESKTOP_INSET, Math.max(DESKTOP_INSET, bounds.width - DESKTOP_INSET - width)),
    y: clamp(finite(value.y, DESKTOP_INSET), DESKTOP_INSET, Math.max(DESKTOP_INSET, bounds.height - DESKTOP_INSET - height)),
    ...("restoreRect" in value && value.restoreRect ? { restoreRect: stripWindowMetadata(normalizeWindowLayout(value.restoreRect, bounds)) } : {}),
  };
}

export function tinyOsLayoutStorageKey(workspaceKey: string, layoutMode: TinyOsLayoutMode): string {
  return `${STORAGE_PREFIX}.v${PERSISTENCE_VERSION}.${encodeURIComponent(workspaceKey || "default")}.${layoutMode}`;
}

export function loadTinyOsLayout(
  storage: Pick<Storage, "getItem"> | undefined,
  workspaceKey: string,
  layoutMode: TinyOsLayoutMode,
): Partial<Record<TinyOsAppId, TinyOsWindowLayout>> | undefined {
  if (!storage) return undefined;
  const raw = storage.getItem(tinyOsLayoutStorageKey(workspaceKey, layoutMode));
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TinyOS layout preference must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== PERSISTENCE_VERSION || !record.windowLayout || typeof record.windowLayout !== "object") {
    throw new Error("TinyOS layout preference version is incompatible");
  }
  return record.windowLayout as Partial<Record<TinyOsAppId, TinyOsWindowLayout>>;
}

export function saveTinyOsLayout(
  storage: Pick<Storage, "setItem"> | undefined,
  workspaceKey: string,
  state: TinyOsUiState,
): void {
  if (!storage) return;
  storage.setItem(tinyOsLayoutStorageKey(workspaceKey, state.layoutMode), JSON.stringify({
    version: PERSISTENCE_VERSION,
    windowLayout: state.windowLayout,
  }));
}

function defaultWindowLayout(
  appId: TinyOsAppId,
  bounds: TinyOsDesktopBounds,
  layoutMode: TinyOsLayoutMode,
): TinyOsWindowLayout {
  if (layoutMode === "compact") return { ...desktopRect(bounds), maximized: false };
  const index = APP_INDEX[appId];
  const availableWidth = Math.max(1, bounds.width - DESKTOP_INSET * 2);
  const availableHeight = Math.max(1, bounds.height - DESKTOP_INSET * 2);
  const primary = appId === "files" || appId === "terminal";
  const width = primary ? availableWidth * .86 : availableWidth * .82;
  const height = primary ? availableHeight * .58 : availableHeight * .76;
  return normalizeWindowLayout({
    height,
    width,
    x: DESKTOP_INSET + (index % 4) * 14,
    y: DESKTOP_INSET + (index % 5) * 18,
  }, bounds);
}

function desktopRect(bounds: TinyOsDesktopBounds): TinyOsWindowRect {
  return {
    height: Math.max(1, bounds.height - DESKTOP_INSET * 2),
    width: Math.max(1, bounds.width - DESKTOP_INSET * 2),
    x: DESKTOP_INSET,
    y: DESKTOP_INSET,
  };
}

function focusWindow(state: TinyOsUiState, appId: TinyOsAppId): TinyOsUiState {
  if (!state.zOrder.includes(appId)) return state;
  return {
    ...state,
    focusedAppId: appId,
    minimizedAppIds: state.minimizedAppIds.filter((candidate) => candidate !== appId),
    zOrder: focusOrder(state.zOrder, appId),
  };
}

function focusOrder(appIds: TinyOsAppId[], focusedAppId?: TinyOsAppId, previous: TinyOsAppId[] = []): TinyOsAppId[] {
  const ordered = unique([...previous.filter((appId) => appIds.includes(appId)), ...appIds]);
  return focusedAppId ? [...ordered.filter((appId) => appId !== focusedAppId), focusedAppId] : ordered;
}

function normalizeBounds(bounds: TinyOsDesktopBounds): TinyOsDesktopBounds {
  return { height: Math.max(1, finite(bounds.height, 600)), width: Math.max(1, finite(bounds.width, 640)) };
}

function stripWindowMetadata(value: TinyOsWindowRect | TinyOsWindowLayout): TinyOsWindowRect {
  return { height: value.height, width: value.width, x: value.x, y: value.y };
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
