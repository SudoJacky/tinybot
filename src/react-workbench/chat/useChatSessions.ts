import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SessionStore } from "../services";
import { createChatSessionApplication, type ChatSessionChange } from "./chatSessionApplication";

export function useChatSessions(store: SessionStore, now: () => number, onChange: (event: ChatSessionChange) => void) {
  const latest = useRef({ now, onChange });
  useLayoutEffect(() => { latest.current = { now, onChange }; });
  const application = useMemo(() => createChatSessionApplication(store, () => latest.current.now()), [store]);
  useEffect(() => {
    const unsubscribe = application.onChange((event) => latest.current.onChange(event));
    void application.load();
    return unsubscribe;
  }, [application]);
  const state = useSyncExternalStore(application.subscribe, application.snapshot);
  return { application, ...state };
}
