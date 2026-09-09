import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";

/** React consumers choose between the full timeline and a stable page summary. */
export function createChatTimelineSource(sessionId: string) {
  let snapshot: ChatTimelineSnapshot | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: ChatTimelineSnapshot | null) {
      if (next && next.sessionId !== sessionId) {
        throw new Error(`Timeline session ${next.sessionId} does not match ${sessionId}.`);
      }
      if (snapshot === next) return;
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export type ChatTimelineSource = ReturnType<typeof createChatTimelineSource>;
