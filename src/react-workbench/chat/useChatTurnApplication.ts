import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createChatTurnApplication } from "./chatTurnApplication";

type Dependencies = Parameters<typeof createChatTurnApplication>[0];
type Context = Parameters<ReturnType<typeof createChatTurnApplication>["observe"]>[1];

/** React adapter; queue mutations are subscribed to by the queue views, not the page. */
export function useChatTurnApplication(
  dependencies: Dependencies,
  sessionId: string,
  context: Context,
) {
  const latest = useRef(dependencies);
  const activeSession = useRef(sessionId);
  const { timeline, capabilities } = context;
  useLayoutEffect(() => { latest.current = dependencies; activeSession.current = sessionId; });
  const application = useMemo(() => createChatTurnApplication({
    dispatch: (command) => latest.current.dispatch(command),
    submitTurn: (...args) => latest.current.submitTurn(...args),
    refreshSessions: () => latest.current.refreshSessions(),
    reportError: (error, targetSessionId) => {
      if (activeSession.current === targetSessionId) latest.current.reportError(error, targetSessionId);
    },
    clearError: () => latest.current.clearError(),
    now: () => latest.current.now(),
    get t() { return latest.current.t; },
  }), []);
  useLayoutEffect(() => {
    application.observe(sessionId, { timeline, capabilities });
  }, [application, sessionId, timeline, capabilities, dependencies.t]);
  useEffect(() => () => application.dispose(), [application]);
  const snapshot = useSyncExternalStore(
    application.subscribe,
    useCallback(() => application.turn(sessionId), [application, sessionId]),
  );
  return { application, ...snapshot };
}
