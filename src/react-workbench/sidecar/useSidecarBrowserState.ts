import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeBrowserSnapshot, NativeBrowserSession } from "../../app-core/native/nativeBrowserSnapshot";
import type { ChatStore } from "../services";
import { subscribeChatEvents } from "../chat/chatEventSource";

type Snapshot = NativeBrowserSnapshot<NativeBrowserSession>;
export function useSidecarBrowserState(chatStore: Pick<ChatStore, "subscribe">, sessionId: string) {
  const [state, setState] = useState<{ browserError: string; browserSnapshot?: Snapshot }>({ browserError: "" });
  const owner = useRef(sessionId);
  useLayoutEffect(() => { owner.current = sessionId; }, [sessionId]);
  const acceptBrowserSnapshot = useCallback((snapshot: Snapshot) => {
    if (owner.current && snapshot.data.sessionId !== owner.current) {
      throw new Error(`Browser snapshot session ${snapshot.data.sessionId} does not match active session ${owner.current}.`);
    }
    setState((current) => {
      const previous = current.browserSnapshot;
      if (previous?.sourceId === snapshot.sourceId && typeof previous.revision === "number"
        && typeof snapshot.revision === "number" && snapshot.revision < previous.revision) return current;
      return { browserError: "", browserSnapshot: snapshot };
    });
  }, []);
  const clearBrowserSnapshot = useCallback((browserSessionId?: string) => {
    setState((current) => browserSessionId && current.browserSnapshot?.data.browserSessionId !== browserSessionId
      ? current : { browserError: "" });
  }, []);
  const clearBrowserError = useCallback(() => setState((current) => ({ ...current, browserError: "" })), []);
  useEffect(() => {
    setState({ browserError: "" });
    if (!sessionId) return;
    return subscribeChatEvents(chatStore, sessionId, (event) => {
      if (!event.browserSnapshot) return;
      try { acceptBrowserSnapshot(event.browserSnapshot); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[sidecar] browser-snapshot.apply.failed", { sessionId, error: message });
        setState((current) => ({ ...current, browserError: message }));
      }
    });
  }, [acceptBrowserSnapshot, chatStore, sessionId]);
  return { state, acceptBrowserSnapshot, clearBrowserSnapshot, clearBrowserError };
}
