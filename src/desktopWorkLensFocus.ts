import type { DesktopTaskCenterItem, DesktopTaskDestination } from "./desktopTaskCenter";

export type DesktopWorkLensFocusSource =
  | "taskCenter"
  | "chat"
  | "knowledge"
  | "cowork"
  | "commandPalette"
  | "failureFeedback";

export interface DesktopWorkLensFocusState {
  current: DesktopTaskCenterItem | null;
  pinned: DesktopTaskCenterItem | null;
  replaceCandidate: DesktopTaskCenterItem | null;
  source: DesktopWorkLensFocusSource | "";
  isPinned: boolean;
  lastResourceRoute: DesktopTaskDestination | null;
}

export type DesktopWorkLensFocusEvent =
  | {
      type: "focusWork";
      source: DesktopWorkLensFocusSource;
      task: DesktopTaskCenterItem;
    }
  | { type: "pin" }
  | { type: "unpin" }
  | { type: "replacePinned" }
  | {
      type: "openResource";
      route: DesktopTaskDestination;
    }
  | { type: "clear" };

export function createDesktopWorkLensFocusState(): DesktopWorkLensFocusState {
  return {
    current: null,
    pinned: null,
    replaceCandidate: null,
    source: "",
    isPinned: false,
    lastResourceRoute: null,
  };
}

export function applyDesktopWorkLensFocusEvent(
  state: DesktopWorkLensFocusState,
  event: DesktopWorkLensFocusEvent,
): DesktopWorkLensFocusState {
  switch (event.type) {
    case "focusWork":
      if (state.isPinned) {
        return {
          ...state,
          replaceCandidate: event.task,
          source: event.source,
        };
      }
      return {
        ...state,
        current: event.task,
        replaceCandidate: null,
        source: event.source,
      };
    case "pin": {
      const current = state.current;
      return {
        ...state,
        pinned: current,
        isPinned: Boolean(current),
        replaceCandidate: null,
      };
    }
    case "unpin":
      return {
        ...state,
        current: state.replaceCandidate ?? state.current,
        pinned: null,
        replaceCandidate: null,
        isPinned: false,
      };
    case "replacePinned": {
      const replacement = state.replaceCandidate ?? state.current;
      return {
        ...state,
        current: replacement,
        pinned: replacement,
        replaceCandidate: null,
        isPinned: Boolean(replacement),
      };
    }
    case "openResource":
      return {
        ...state,
        lastResourceRoute: event.route,
      };
    case "clear":
      return createDesktopWorkLensFocusState();
    default:
      return state;
  }
}
