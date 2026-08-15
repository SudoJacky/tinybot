import { useEffect, useMemo, useReducer, useRef } from "react";
import type { TinyOsAppId, TinyOsWindow } from "../../app-core/chat/tinyOsDesktopModel";
import {
  createTinyOsUiState,
  loadTinyOsLayout,
  reduceTinyOsUiState,
  saveTinyOsLayout,
  type TinyOsLayoutMode,
  type TinyOsUiState,
  type TinyOsWindowRect,
} from "../../app-core/chat/tinyOsUiState";

const sessionUiState = new Map<string, TinyOsUiState>();

export type TinyOsWindowManager = {
  actions: {
    focus: (appId: TinyOsAppId) => void;
    maximize: (appId: TinyOsAppId) => void;
    minimize: (appId: TinyOsAppId) => void;
    reset: () => void;
    setActiveTab: (appId: TinyOsAppId, tabId: string) => void;
    setRect: (appId: TinyOsAppId, rect: TinyOsWindowRect) => void;
    snap: (appId: TinyOsAppId, edge: "left" | "right") => void;
  };
  availableApps: ReadonlySet<TinyOsAppId>;
  desktopRef: React.RefObject<HTMLElement | null>;
  initialWindowIds: ReadonlySet<string>;
  state: TinyOsUiState;
  visibleWindows: TinyOsWindow[];
};

export function useTinyOsWindowManager({
  activeAppId,
  browserNeedsUser,
  browserSessionAvailable,
  history,
  layoutMode,
  sessionKey,
  syncKey,
  windows,
  workspaceKey,
}: {
  activeAppId?: TinyOsAppId;
  browserNeedsUser: boolean;
  browserSessionAvailable: boolean;
  history: boolean;
  layoutMode: TinyOsLayoutMode;
  sessionKey?: string;
  syncKey: string;
  windows: TinyOsWindow[];
  workspaceKey: string;
}): TinyOsWindowManager {
  const desktopRef = useRef<HTMLElement>(null);
  const initialWindowIds = useRef(new Set(windows.map((window) => window.id)));
  const initialAppIds = useRef(windows.map((window) => window.appId));
  const sessionUiKey = sessionKey ? `${workspaceKey}:${sessionKey}` : undefined;
  const [state, dispatch] = useReducer(reduceTinyOsUiState, undefined, () => {
    const cached = sessionUiKey ? sessionUiState.get(sessionUiKey) : undefined;
    if (cached) {
      return reduceTinyOsUiState(cached, {
        appIds: initialAppIds.current,
        bounds: cached.bounds,
        layoutMode,
        preferredActiveAppId: cached.focusedAppId,
        type: "sync",
      });
    }
    let restoredLayout;
    try {
      restoredLayout = loadTinyOsLayout(typeof window === "undefined" ? undefined : window.localStorage, workspaceKey, layoutMode);
    } catch (error) {
      console.error("TinyOS could not restore its saved layout; the deterministic layout will be used.", error);
    }
    return createTinyOsUiState({
      appIds: initialAppIds.current,
      bounds: { height: 560, width: layoutMode === "compact" ? 420 : 640 },
      layoutMode,
      preferredActiveAppId: activeAppId,
      restoredLayout,
    });
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const appIds = useMemo(() => windows.map((window) => window.appId), [windows]);
  const browserSessionWasAvailable = useRef(browserSessionAvailable);
  const browserNeededUser = useRef(false);
  const previousHistoryMode = useRef(history);

  useEffect(() => {
    const currentState = stateRef.current;
    const returningToLive = previousHistoryMode.current && !history;
    const browserBecameAvailable = !browserSessionWasAvailable.current && browserSessionAvailable;
    const browserBeganNeedingUser = !browserNeededUser.current && browserNeedsUser;
    previousHistoryMode.current = history;
    browserSessionWasAvailable.current = browserSessionAvailable;
    browserNeededUser.current = browserNeedsUser;
    dispatch({
      appIds,
      bounds: currentState.bounds,
      layoutMode,
      preferredActiveAppId: browserBecameAvailable || browserBeganNeedingUser
        ? "browser"
        : history || returningToLive ? activeAppId : currentState.focusedAppId,
      type: "sync",
    });
  }, [activeAppId, appIds, browserNeedsUser, browserSessionAvailable, history, layoutMode, syncKey]);

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width < 1 || height < 1) return;
      dispatch({
        appIds,
        bounds: { height, width },
        layoutMode,
        preferredActiveAppId: stateRef.current.focusedAppId,
        type: "sync",
      });
    });
    observer.observe(desktop);
    return () => observer.disconnect();
  }, [appIds, layoutMode]);

  useEffect(() => {
    saveTinyOsLayout(typeof window === "undefined" ? undefined : window.localStorage, workspaceKey, {
      layoutMode: state.layoutMode,
      windowLayout: state.windowLayout,
    });
  }, [state.layoutMode, state.windowLayout, workspaceKey]);

  useEffect(() => {
    if (sessionUiKey) sessionUiState.set(sessionUiKey, state);
  }, [sessionUiKey, state]);

  const visibleWindows = useMemo(() => {
    const visible = windows.filter((window) => (
      !state.minimizedAppIds.includes(window.appId)
      && (state.layoutMode !== "compact" || window.appId === state.focusedAppId)
    ));
    return visible.sort((left, right) => state.zOrder.indexOf(left.appId) - state.zOrder.indexOf(right.appId));
  }, [state.focusedAppId, state.layoutMode, state.minimizedAppIds, state.zOrder, windows]);
  const availableApps = useMemo(() => new Set(appIds), [appIds]);

  return {
    actions: {
      focus: (appId) => {
        if (availableApps.has(appId)) dispatch({ appId, type: "focus" });
      },
      maximize: (appId) => dispatch({ appId, type: "maximize_toggle" }),
      minimize: (appId) => dispatch({ appId, type: "minimize" }),
      reset: () => dispatch({ type: "reset" }),
      setActiveTab: (appId, tabId) => dispatch({ appId, tabId, type: "set_active_tab" }),
      setRect: (appId, rect) => dispatch({ appId, rect, type: "set_rect" }),
      snap: (appId, edge) => dispatch({ appId, edge, type: "snap" }),
    },
    availableApps,
    desktopRef,
    initialWindowIds: initialWindowIds.current,
    state,
    visibleWindows,
  };
}
