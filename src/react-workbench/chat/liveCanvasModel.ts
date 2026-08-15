import type { ChatStep } from "../../app-core/chat/chatTurnModel";
import type { TinyOsTimelineEntry } from "../../app-core/chat/tinyOsDesktopModel";

export type LiveCanvasMode = "live_follow" | "history";
export type LiveCanvasEntry = TinyOsTimelineEntry;

export type LiveCanvasState = {
  mode: LiveCanvasMode;
  selection?: { eventIndex?: number; itemId: string; turnId: string };
  surface: "panel" | "expanded";
  visibility: "closed" | "closing" | "open";
};

export type LiveCanvasAction =
  | { type: "close" }
  | { type: "close_complete" }
  | { type: "expand_toggle" }
  | { type: "return_live" }
  | { type: "select"; eventIndex?: number; itemId: string; turnId: string }
  | { type: "toggle" };

export const INITIAL_LIVE_CANVAS_STATE: LiveCanvasState = {
  mode: "live_follow",
  surface: "panel",
  visibility: "closed",
};

export const MIN_TINYOS_WIDTH = 380;
const TINYOS_DESKTOP_RESERVED_WIDTH = 520;
const TINYOS_OVERLAY_RESERVED_WIDTH = 64;

export function reduceLiveCanvasState(state: LiveCanvasState, action: LiveCanvasAction): LiveCanvasState {
  switch (action.type) {
    case "close":
      return state.visibility === "open" ? { ...state, visibility: "closing" } : state;
    case "close_complete":
      return state.visibility === "closing" ? { ...state, visibility: "closed" } : state;
    case "expand_toggle":
      return { ...state, surface: state.surface === "expanded" ? "panel" : "expanded", visibility: "open" };
    case "return_live":
      return { ...state, mode: "live_follow", visibility: "open" };
    case "select":
      return {
        ...state,
        mode: "history",
        selection: {
          ...(action.eventIndex !== undefined ? { eventIndex: action.eventIndex } : {}),
          itemId: action.itemId,
          turnId: action.turnId,
        },
        visibility: "open",
      };
    case "toggle":
      return state.visibility === "open"
        ? { ...state, visibility: "closing" }
        : { ...state, mode: "live_follow", visibility: "open" };
  }
}

export function clampTinyOsWidth(widthPx: number, viewportWidth = currentViewportWidth()): number {
  return Math.min(tinyOsMaxWidth(viewportWidth), Math.max(MIN_TINYOS_WIDTH, Math.round(widthPx)));
}

export function tinyOsMaxWidth(viewportWidth = currentViewportWidth()): number {
  const reservedWidth = viewportWidth >= 1_280
    ? TINYOS_DESKTOP_RESERVED_WIDTH
    : TINYOS_OVERLAY_RESERVED_WIDTH;
  return Math.max(MIN_TINYOS_WIDTH, Math.floor(viewportWidth - reservedWidth));
}

export function liveCanvasEntryForStep(turnId: string, step: ChatStep): LiveCanvasEntry {
  return { step, turnId };
}

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1_240 : window.innerWidth;
}
