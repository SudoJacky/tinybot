import type { ChatEvent, ChatStore } from "../services";

type Source = Pick<ChatStore, "subscribe">;
type Channel = { listeners: Set<(event: ChatEvent) => void>; unsubscribe(): void };
const sources = new WeakMap<Source, Map<string, Channel>>();

/** Chat and Sidecar share one native subscription while owning their own event consumers. */
export function subscribeChatEvents(source: Source, sessionId: string, listener: (event: ChatEvent) => void) {
  let channels = sources.get(source);
  if (!channels) { channels = new Map(); sources.set(source, channels); }
  let channel = channels.get(sessionId);
  if (!channel) {
    const listeners = new Set([listener]);
    const unsubscribe = source.subscribe(sessionId, (event) => {
      for (const receive of [...listeners]) receive(event);
    });
    channel = { listeners, unsubscribe };
    channels.set(sessionId, channel);
  } else channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
    if (!channel.listeners.size) {
      channel.unsubscribe();
      channels.delete(sessionId);
    }
  };
}
