import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { captureConversationView, restoreConversationView, type ConversationViewState } from "./conversationViewport";

type SearchTarget = { sessionId: string; turnId: string; signal: number };

/** Owns session scroll memory and cancels restoration when navigation or user intent changes. */
export function useConversationViewport({ sessionId, timelineSessionId, searchTarget }: {
  sessionId: string;
  timelineSessionId?: string;
  searchTarget?: SearchTarget;
}) {
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const views = useRef(new Map<string, ConversationViewState>());
  const activeSession = useRef(sessionId);
  const pendingRestore = useRef("");
  const cancelRestore = useRef<(() => void) | undefined>(undefined);
  const stickToLatest = useRef(true);
  const lastSearchSignal = useRef<number | undefined>(undefined);
  const [showBackToLatest, setShowBackToLatest] = useState(false);

  const cancelRestoration = useCallback(() => {
    cancelRestore.current?.();
    cancelRestore.current = undefined;
  }, []);

  useLayoutEffect(() => {
    activeSession.current = sessionId;
    pendingRestore.current = sessionId;
    const view = views.current.get(sessionId);
    stickToLatest.current = view?.stickToLatest ?? true;
    setShowBackToLatest(view ? !view.stickToLatest : false);
    return cancelRestoration;
  }, [cancelRestoration, sessionId]);

  const onContentChanged = useCallback(() => {
    // A switched-away timeline must not scroll the newly selected conversation.
    if (activeSession.current !== sessionId || timelineSessionId !== sessionId) return;
    cancelRestoration();
    const element = conversationRef.current;
    if (!element) return;
    if (searchTarget?.sessionId === sessionId && lastSearchSignal.current !== searchTarget.signal) {
      const turn = element.querySelector<HTMLElement>(`[data-scroll-anchor="${CSS.escape(`turn:${searchTarget.turnId}`)}"]`);
      if (turn) {
        stickToLatest.current = false;
        pendingRestore.current = "";
        turn.scrollIntoView({ block: "center" });
        turn.tabIndex = -1;
        turn.focus({ preventScroll: true });
        lastSearchSignal.current = searchTarget.signal;
        setShowBackToLatest(true);
        return;
      }
    }
    const view = views.current.get(sessionId);
    if (pendingRestore.current === sessionId && view && !view.stickToLatest) {
      cancelRestore.current = restoreConversationView(element, view, () => {
        pendingRestore.current = "";
      });
      return cancelRestore.current;
    }
    pendingRestore.current = "";
    if (stickToLatest.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [cancelRestoration, searchTarget, sessionId, timelineSessionId]);

  function onScroll() {
    const element = conversationRef.current;
    if (!element) return;
    cancelRestoration();
    pendingRestore.current = "";
    const view = captureConversationView(element);
    views.current.set(sessionId, view);
    stickToLatest.current = view.stickToLatest;
    setShowBackToLatest(!view.stickToLatest);
  }

  /** Without a behavior, wait for the sent input to reach the timeline before scrolling. */
  function followLatest(behavior?: ScrollBehavior) {
    cancelRestoration();
    pendingRestore.current = "";
    stickToLatest.current = true;
    views.current.delete(sessionId);
    setShowBackToLatest(false);
    if (behavior) endRef.current?.scrollIntoView({ behavior, block: "end" });
  }

  function replaceSession(previousSessionId: string, nextSessionId: string) {
    if (previousSessionId === nextSessionId) return;
    const view = views.current.get(previousSessionId);
    views.current.delete(previousSessionId);
    if (view) views.current.set(nextSessionId, view);
    if (pendingRestore.current === previousSessionId) {
      cancelRestoration();
      pendingRestore.current = nextSessionId;
    }
  }

  function removeSession(removedSessionId: string) {
    views.current.delete(removedSessionId);
    if (pendingRestore.current === removedSessionId) {
      cancelRestoration();
      pendingRestore.current = "";
    }
  }

  return { conversationRef, endRef, showBackToLatest, onContentChanged, onScroll, followLatest, replaceSession, removeSession };
}
