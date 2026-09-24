import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallState } from "../../app-core/chat/chatTurnContracts";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { TeamTaskStatus } from "./TeamTaskStatus";
import { ChatTeamContext } from "./chatTeamContext";
import { useChatTeamRun, chatTeamsApi } from "./useChatTeamRun";
import "./chatTeamCard.css";

export function recruitedRunId(tool: ToolCallState): string | undefined {
  if (tool.name !== "team.recruit") return;
  const queue: unknown[] = [tool.resultJson];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const value = queue[i];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.runId === "string" && Array.isArray(record.tasks)) return record.runId;
    queue.push(record.raw, record.result, record.executor);
  }
}


/** Historical cards load the board on expansion; employee logs belong to the inspector. */
export function ChatTeamCard({ runId, loadRun = chatTeamsApi.get }: {
  runId: string; loadRun?: typeof chatTeamsApi.get;
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const inspector = useContext(ChatTeamContext);
  const inspecting = inspector?.run?.id === runId;
  const board = useChatTeamRun(runId, open && !inspecting, loadRun);
  const run = inspecting ? inspector.run : board.run;
  return <details className="chat-team-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("teams.recruitment")}{run ? " · " + t("teams.recruitedCount", { count: run.spec.members.length }) : ""}</summary>
    {open && <div className="chat-team-card__body">
      {board.error && !inspecting && <p role="alert">{board.error} <button onClick={board.refresh}>{t("teams.refresh")}</button></p>}
      {!run && !board.error && <p role="status">{t("teams.loading")}</p>}
      {run && <>
        {run.error && <p role="alert">{run.error}</p>}
        <div className="chat-team-card__employees">
          {run.tasks.map(record => {
            const employee = run.spec.members.find(value => value.id === record.task.memberId)!;
            const selected = inspecting && inspector.selectedTaskId === record.task.id;
            return <button key={record.task.id} aria-pressed={selected} disabled={!inspector}
              onClick={event => inspector?.open(run, record.task.id, event.currentTarget)}>
              <TeamMemberAvatar memberId={employee.id} />
              <span><strong>{employee.displayName}</strong><small>{record.task.title}</small></span>
              <span className="chat-team-card__state">{selected && <small>{t("teams.viewing")}</small>}<TeamTaskStatus run={run} record={record} animate={false} /></span>
            </button>;
          })}
        </div>
      </>}
    </div>}
  </details>;
}
