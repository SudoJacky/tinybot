import type { Ref } from "react";
import { Check, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TeamRun, TeamTaskRecord } from "../../app-core/native/desktopNativeTeams";
import { taskWaitReason } from "./teamPresentation";
import { TeamElapsedTime, TeamTaskStatus } from "./TeamTaskStatus";
import type { TeamActivity } from "./useTeamActivity";

export function TeamTaskFeed({ run, tasks, selectedTaskId, selectedRef, activity, onSelect }: {
  run: TeamRun; tasks: TeamTaskRecord[]; selectedTaskId: string;
  selectedRef: Ref<HTMLButtonElement>; activity: Record<string, TeamActivity>; onSelect(id: string): void;
}) {
  const { t } = useTranslation("common");
  return <div className="team-progress-feed">
    <header><h2>{t("teams.overallProgress")}</h2><p>{t("teams.progressHint")}</p></header>
    <ol>
      {tasks.map((record, index) => {
        const attempt = record.attempts.slice(-1)[0];
        const live = attempt && activity[attempt.threadId];
        const wait = taskWaitReason(run, record);
        const summary = record.status === "running" ? live?.error ? t("teams.activityUnavailable")
          : live?.items.slice(-1)[0]?.text ?? t("teams.noActivity")
          : attempt?.error ?? attempt?.message?.summary ?? attempt?.output;
        return <li key={record.task.id}>
          <button ref={selectedTaskId === record.task.id ? selectedRef : undefined}
            className={`team-task-row is-${record.status} ${selectedTaskId === record.task.id ? "is-selected" : ""}`}
            aria-pressed={selectedTaskId === record.task.id} onClick={() => onSelect(record.task.id)}>
            <span className="team-number">
              {record.status === "succeeded" ? <><Check size={15} /><span className="react-sr-only">{String(index + 1).padStart(2, "0")}</span></> : String(index + 1).padStart(2, "0")}
            </span>
            <span className="team-task-title">
              <strong>{record.task.title}</strong>
              <span>{run.spec.members.find((member) => member.id === record.task.memberId)?.displayName}
                {record.task.id === run.finalTaskId && <small>{t("teams.final")}</small>}
              </span>
              {summary && <span className="team-task-summary">{summary.trim().split(/\n\s*\n/, 1)[0].slice(0, 500)}</span>}
              {wait && <span className="team-task-summary">{t(`teams.${wait.key}`, { task: wait.value })}</span>}
              {!!attempt?.message?.artifacts.length && <span className="team-feed-artifacts"><FileText size={13} />{t("teams.artifactCount", { count: attempt.message.artifacts.length })}</span>}
              {attempt && <span className="team-feed-time">
                {t("teams.startedAt")} <time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                {attempt.finishedAt && <> · {t("teams.finishedAt")} <time dateTime={attempt.finishedAt}>{new Date(attempt.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></>}
              </span>}
            </span>
            <span className="team-task-state"><TeamTaskStatus run={run} record={record} />
              {record.status === "running" && attempt && <TeamElapsedTime key={attempt.threadId} attempt={attempt} />}
            </span>
          </button>
        </li>;
      })}
    </ol>
  </div>;
}
