import { memo, useEffect, useSyncExternalStore, type ComponentProps } from "react";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import { ChatTimeline } from "./ChatTimeline";
import type { ChatTimelineSource } from "./chatTimelineSource";

const EMPTY_TURNS: ChatTurn[] = [];

/** Streaming snapshots terminate here instead of rerendering the Chat route. */
export const LiveChatTimeline = memo(function LiveChatTimeline({ source, formCount, onContentChanged, ...props }: Omit<ComponentProps<typeof ChatTimeline>, "turns"> & {
  source: ChatTimelineSource;
  formCount: number;
  onContentChanged(): void | (() => void);
}) {
  const timeline = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => onContentChanged(), [onContentChanged, timeline, props.optimisticMessages, props.providerRetry, formCount]);
  return <ChatTimeline {...props} turns={timeline?.turns ?? EMPTY_TURNS} />;
});
