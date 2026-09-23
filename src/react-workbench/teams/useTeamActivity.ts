import { useEffect, useState } from "react";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStepKind, ChatStepStatus } from "../../app-core/chat/chatTurnContracts";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { ChatStore } from "../services";
import { subscribeChatEvents } from "../chat/chatEventSource";

export type TeamActivitySource = Pick<ChatStore, "readTimeline" | "subscribe">;
export type TeamActivityItem = { id: string; kind: ChatStepKind; text: string; status: ChatStepStatus };
export type TeamActivity = { items: TeamActivityItem[]; loading: boolean; error?: string };

export function projectTeamActivity(snapshot: ChatTimelineSnapshot, turnId: string): TeamActivityItem[] {
  const turn = snapshot.turns.find((item) => item.id === turnId);
  // Use the canonical projection, not user input, reasoning or guessed progress.
  return (turn?.steps ?? []).filter((step) =>
    ["message", "tool_call", "plan", "delegate", "error"].includes(step.kind),
  ).map((step) => ({
    id: step.id,
    kind: step.kind,
    text: (step.kind === "tool_call" ? step.toolCall?.name ?? step.title
      : step.kind === "message" ? step.summary || step.title
      : step.kind === "plan" ? step.plan?.currentStep || step.title
      : step.title),
    status: step.status,
  }));
}

export function useTeamActivity(source: TeamActivitySource | undefined, run: TeamRun, selectedTaskId: string) {
  const [activity, setActivity] = useState<Record<string, TeamActivity>>({});
  const [epoch, setEpoch] = useState(0);
  // Only observe active workers and the inspected task; do not hydrate every historical Thread.
  const targetsKey = JSON.stringify(run.tasks.filter((record) =>
    record.status === "running" || record.task.id === selectedTaskId,
  ).flatMap((record) => {
    const attempt = record.attempts.slice(-1)[0];
    return attempt ? [[attempt.threadId, attempt.turnId, attempt.status]] : [];
  }));
  useEffect(() => {
    if (!source?.readTimeline) return;
    const targets = JSON.parse(targetsKey) as string[][];
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: Record<string, TeamActivity> = {};
    const publish = (threadId: string, value: TeamActivity) => {
      if (disposed) return;
      pending[threadId] = value;
      timer ??= setTimeout(() => {
        setActivity((previous) => ({ ...previous, ...pending }));
        timer = undefined;
      }, 80);
    };
    const unsubscribes = targets.map(([threadId, turnId]) => {
      let receivedTimeline = false;
      let items: TeamActivityItem[] = [];
      publish(threadId, { items, loading: true });
      const accept = (snapshot: ChatTimelineSnapshot) => {
        if (snapshot.sessionId !== threadId) return;
        items = projectTeamActivity(snapshot, turnId);
        publish(threadId, { items, loading: false });
      };
      const unsubscribe = subscribeChatEvents(source, threadId, (event) => {
        if (event.timeline?.sessionId === threadId) {
          receivedTimeline = true;
          accept(event.timeline);
        } else if (event.type === "timeline.error") {
          receivedTimeline = true;
          publish(threadId, { items, loading: false, error: event.error });
        }
      });
      void source.readTimeline!(threadId).then((snapshot) => {
        if (!receivedTimeline) accept(snapshot);
      }).catch((error: unknown) => {
        if (!receivedTimeline) publish(threadId, { items, loading: false, error: String(error) });
      });
      return unsubscribe;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [source, targetsKey, epoch]);
  return { activity, refresh: () => setEpoch((value) => value + 1) };
}
