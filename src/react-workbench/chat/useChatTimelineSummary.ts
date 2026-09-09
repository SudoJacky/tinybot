import { useMemo, useSyncExternalStore } from "react";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatTimelineSource } from "./chatTimelineSource";
import { projectLatestContextUsage, type ContextUsageDefaults } from "./chatContextUsage";

/** Page state deliberately excludes streaming text, tool payloads and timestamps. */
export function useChatTimelineSummary(source: ChatTimelineSource, defaults: ContextUsageDefaults) {
  const select = useMemo(() => {
    let previousTimeline: ChatTimelineSnapshot | null | undefined;
    let previous = projectSummary(null, defaults);
    let previousKey = JSON.stringify(previous);
    return () => {
      const timeline = source.getSnapshot();
      if (timeline === previousTimeline) return previous;
      previousTimeline = timeline;
      const next = projectSummary(timeline, defaults);
      // Only the small UI summary is compared, never messages or the full timeline.
      const key = JSON.stringify(next);
      if (key !== previousKey) { previous = next; previousKey = key; }
      return previous;
    };
  }, [source, defaults]);
  return useSyncExternalStore(source.subscribe, select);
}

function projectSummary(timeline: ChatTimelineSnapshot | null, defaults: ContextUsageDefaults) {
  const turns = timeline?.turns ?? [];
  const reversed = [...turns].reverse();
  const active = reversed.find((turn) => (
    turn.status === "pending" || turn.status === "running" || turn.status === "awaiting_user"
  ));
  return {
    sessionId: timeline?.sessionId,
    turnCount: turns.length,
    completedTask: turns.some((turn) => turn.status === "completed" && Boolean(turn.userMessage.text.trim())),
    activeTurnId: active?.id,
    activeTurnStatus: active?.status,
    latestTurnStatus: turns[turns.length - 1]?.status,
    latestFailedTurnId: reversed.find((turn) => turn.status === "failed" || turn.status === "interrupted")?.id ?? "",
    contextUsage: projectLatestContextUsage(turns, defaults),
    floatingPlan: latestTurnPlan(timeline),
  };
}

function latestTurnPlan(timeline: ChatTimelineSnapshot | null) {
  const turns = timeline?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const step = [...turn.steps].reverse().find((candidate) => candidate.kind === "plan" && candidate.plan);
    if (step?.plan) return {
      identityKey: `${turn.id}:${step.id}`,
      plan: step.plan,
      revisionKey: JSON.stringify({ plan: step.plan, status: step.status }),
    };
  }
  return undefined;
}
