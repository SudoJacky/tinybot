import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";
import { TeamArtifacts } from "./TeamMessage";

export function TeamFiles({ run, workspaceStore, onSelectTask, onOpenThread }: {
  run: TeamRun;
  workspaceStore: PreviewWorkspaceStore;
  onSelectTask(id: string): void;
  onOpenThread(id: string): void;
}) {
  const { t } = useTranslation("common");
  const [historyOpen, setHistoryOpen] = useState(false);
  const entries = run.tasks.flatMap((record) => record.attempts.flatMap((attempt, index) =>
    attempt.message?.artifacts.length ? [{ record, attempt, index, historical: index < record.attempts.length - 1 }] : [],
  ));
  function groups(historical: boolean) {
    return entries.filter((entry) => entry.historical === historical).map(({ record, attempt, index }) =>
      <article className="team-file-group" key={attempt.threadId}>
        <h3><button onClick={() => onSelectTask(record.task.id)}>{record.task.title}</button></h3>
        <p>{run.spec.members.find((member) => member.id === record.task.memberId)?.displayName}
          {" · "}{t("teams.attemptNumber", { number: index + 1 })}
          {attempt.finishedAt && <> · <time dateTime={attempt.finishedAt}>{new Date(attempt.finishedAt).toLocaleString()}</time></>}
        </p>
        <TeamArtifacts runId={run.id} attempt={attempt} workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} />
        <button onClick={() => onOpenThread(attempt.threadId)}>{t("teams.openRecord")}</button>
      </article>,
    );
  }
  const historicalCount = entries.filter((entry) => entry.historical).length;
  return <div className="team-files">
    <p>{t("teams.filesHint")}</p>
    {!entries.some((entry) => !entry.historical) && <p>{t("teams.noFiles")}</p>}
    {groups(false)}
    {historicalCount > 0 && <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
      <summary>{t("teams.earlierAttempts", { count: historicalCount })}</summary>
      {historyOpen && groups(true)}
    </details>}
  </div>;
}
