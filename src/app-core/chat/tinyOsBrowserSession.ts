import type {
  TinyOsBrowserCaptureV1,
  TinyOsBrowserTabV1,
  TinyOsNativeBrowserSession,
} from "./tinyOsNativeSnapshot";

export type TinyOsBrowserInteractionKind = "click" | "navigate" | "type";

export type TinyOsBrowserInteractionTarget = {
  browserSessionId: string;
  captureId: string;
  tabId: string;
};

export type TinyOsBrowserInteractionValidation =
  | {
      capture: TinyOsBrowserCaptureV1;
      session: TinyOsNativeBrowserSession;
      status: "accepted";
      tab: TinyOsBrowserTabV1;
    }
  | {
      currentCapture?: TinyOsBrowserCaptureV1;
      reason: string;
      reasonCode: "capture_missing" | "capture_stale" | "session_mismatch" | "tab_missing";
      status: "rejected";
    };

export function validateTinyOsBrowserInteractionTarget(
  session: TinyOsNativeBrowserSession | undefined,
  target: TinyOsBrowserInteractionTarget,
): TinyOsBrowserInteractionValidation {
  if (!session || session.browserSessionId !== target.browserSessionId) {
    return {
      reason: "The browser session is unavailable or no longer matches this action.",
      reasonCode: "session_mismatch",
      status: "rejected",
    };
  }
  const tab = session.tabs.find(({ tabId }) => tabId === target.tabId);
  if (!tab) {
    return {
      reason: "The target browser tab is no longer present in the current session snapshot.",
      reasonCode: "tab_missing",
      status: "rejected",
    };
  }
  const currentCapture = tab.currentCaptureId
    ? tab.captures.find(({ captureId }) => captureId === tab.currentCaptureId)
    : undefined;
  const capture = tab.captures.find(({ captureId }) => captureId === target.captureId);
  if (!capture) {
    return {
      ...(currentCapture ? { currentCapture } : {}),
      reason: "The target browser capture is no longer retained by the current tab.",
      reasonCode: "capture_missing",
      status: "rejected",
    };
  }
  if (capture.stale || capture.captureId !== tab.currentCaptureId) {
    return {
      ...(currentCapture ? { currentCapture } : {}),
      reason: "The target browser capture is stale. Review the current capture before interacting.",
      reasonCode: "capture_stale",
      status: "rejected",
    };
  }
  return { capture, session, status: "accepted", tab };
}
