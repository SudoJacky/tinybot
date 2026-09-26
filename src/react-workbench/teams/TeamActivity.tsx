import { useState } from "react";
import { ListChecks, Users, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { ResultFilePreview, useResultFilePreview, type PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";
import { TimelineActivity } from "../chat/TimelineActivity";
import { ToolActivityItem } from "../chat/ToolActivityItem";
import { MessageReasoning, reasoningDurationMs } from "../chat/MessageReasoning";
import { isApplyPatchToolCall, PatchDiffCard, patchChangeSetFromToolResult } from "../chat/PatchDiffCard";
import { DataViewCard } from "../chat/DataViewCard";
import type { TeamActivity as Activity, TeamActivityItem } from "./useTeamActivity";

export type TeamActivityView = { expanded: boolean; historyCount: number };

export function TeamActivity({ activity, onRefresh, threadId, workspacePath, workspaceStore, savedView, onViewChange }: {
  activity?: Activity; onRefresh(): void; threadId: string; workspacePath: string; workspaceStore: PreviewWorkspaceStore;
  savedView?: TeamActivityView; onViewChange(view: TeamActivityView): void;
}) {
  const { t } = useTranslation("common");
  const [view, setView] = useState(savedView ?? { expanded: false, historyCount: 20 });
  const { expanded, historyCount } = view;
  function updateView(next: TeamActivityView) { setView(next); onViewChange(next); }
  const preview = useResultFilePreview(workspacePath);
  const items = activity?.items ?? [];
  function rows(entries: TeamActivityItem[]) {
    return entries.map((item) => <div key={item.id} className={`team-work-event is-${item.kind}`}>
      {item.kind === "message" ? <AssistantMarkdown text={item.text} streaming={item.status === "running"} onOpenFileLink={preview.open} />
        : item.kind === "reasoning" ? <MessageReasoning text={item.text} streaming={item.status === "running"} durationMs={reasoningDurationMs(item)} />
        : item.kind === "tool_call" ? item.toolCall && isApplyPatchToolCall(item.toolCall) && patchChangeSetFromToolResult(item.toolCall.resultJson)?.files.length
          ? <PatchDiffCard status={item.status} toolCall={item.toolCall} />
          : <ToolActivityItem status={item.status} fallbackSummary={item.summary} toolCall={item.toolCall ?? { id: item.id, name: item.text }} />
        : <TimelineActivity icon={item.kind === "plan" ? <ListChecks size={15} /> : item.kind === "delegate" ? <Users size={15} /> : <AlertCircle size={15} />}
          title={item.text} status={<span className={`team-status is-${item.status}`}>{t(`teams.activityStatus.${item.status}`)}</span>}>
          {item.plan && <div>
            {item.plan.explanation && <p>{item.plan.explanation}</p>}
            <ol>{item.plan.steps.map((step, index) => <li key={index} data-status={step.status}>
              {step.step} · {t(`teams.activityStatus.${step.status === "in_progress" ? "running" : step.status}`)}
            </li>)}</ol>
          </div>}
        </TimelineActivity>}
      {item.artifacts?.filter(artifact => artifact.kind === "data_view").map(artifact => <DataViewCard key={artifact.id} artifact={artifact} />)}
    </div>);
  }
  return <section className="team-activity" aria-label={t("teams.recentActivity")}>
    {activity?.error && <div className="team-error" role="alert">
      {activity.error}<button onClick={onRefresh}>{t("teams.refresh")}</button>
    </div>}
    {!items.length && <p>{t(activity?.loading ? "teams.loading" : "teams.noActivity")}</p>}
    {items.length > 5 && <details open={expanded} onToggle={(event) => updateView({ ...view, expanded: event.currentTarget.open })}>
      <summary>{t("teams.earlierActivity", { count: items.length - 5 })}</summary>
      {expanded && <>
        {items.length > historyCount + 5 && <button onClick={() => updateView({ ...view, historyCount: historyCount + 20 })}>{t("teams.loadEarlierActivity")}</button>}
        {rows(items.slice(-historyCount - 5, -5))}
      </>}
    </details>}
    {rows(items.slice(-5))}
    <ResultFilePreview preview={preview} threadId={threadId} workspaceStore={workspaceStore} />
  </section>;
}
