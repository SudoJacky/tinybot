import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecruitmentBatch } from "./teamRecruitment";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { TeamTaskStatus } from "./TeamTaskStatus";
import { ChatTeamContext } from "./chatTeamContext";
import { useChatTeamRun, chatTeamsApi } from "./useChatTeamRun";
import "./chatTeamCard.css";

/** Historical cards load the board on expansion; employee logs belong to the inspector. */
export function ChatTeamCard({ runId, batch, loadRun = chatTeamsApi.get }: {
  runId: string; batch?: RecruitmentBatch; loadRun?: typeof chatTeamsApi.get;
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const inspector = useContext(ChatTeamContext);
  const inspecting = inspector?.run?.id === runId;
  const board = useChatTeamRun(runId, open && !inspecting, loadRun);
  const observed = inspecting ? inspector.run : undefined;
  const accept = board.accept;
  useEffect(() => { if (observed) accept(observed); }, [observed, accept]);
  const run = observed && (!board.run || observed.revision >= board.run.revision) ? observed : board.run;
  const records = batch?.tasks.map(task => run?.tasks.find(value => value.task.id === task.taskId && value.task.memberId === task.memberId));
  const missing = run && batch && (records?.some(record => !record) || batch.memberIds.some(id => !run.spec.members.some(member => member.id === id)));
  return <details className="chat-team-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("teams.recruitment")}{batch ? " · " + t("teams.recruitmentBatchCount", { count: batch.memberIds.length, tasks: batch.tasks.length }) : ""}</summary>
    {open && <div className="chat-team-card__body">
      {!batch && <p>{t("teams.recruitmentBatchUnknown")}</p>}
      {board.error && !inspecting && <p role="alert">{board.error} <button onClick={board.refresh}>{t("teams.refresh")}</button></p>}
      {!run && !board.error && <p role="status">{t("teams.loading")}</p>}
      {run && <>
        {run.error && <p role="alert">{run.error}</p>}
        {missing && <p role="alert">{t("teams.recruitmentBatchMissing")}</p>}
        {(!batch || missing) ? <button disabled={!inspector || !run.tasks.length}
          onClick={event => inspector?.open(run, run.tasks[0].task.id, event.currentTarget)}>{t("teams.viewTeam")}</button>
          : <div className="chat-team-card__employees">
          {records?.map(record => {
            if (!record) return null;
            const employee = run.spec.members.find(value => value.id === record.task.memberId)!;
            const selected = inspecting && inspector.selectedTaskId === record.task.id;
            return <button key={record.task.id} aria-pressed={selected} disabled={!inspector}
              onClick={event => inspector?.open(run, record.task.id, event.currentTarget)}>
              <TeamMemberAvatar memberId={employee.id} />
              <span><strong>{employee.displayName}</strong><small>{record.task.title}</small></span>
              <span className="chat-team-card__state">{selected && <small>{t("teams.viewing")}</small>}<TeamTaskStatus run={run} record={record} animate={false} /></span>
            </button>;
          })}
          {batch.memberIds.filter(id => !batch.tasks.some(task => task.memberId === id)).map(id => {
            const employee = run.spec.members.find(member => member.id === id)!;
            return <button key={id} disabled><TeamMemberAvatar memberId={id} /><span><strong>{employee.displayName}</strong><small>{t("teams.idleMember")}</small></span></button>;
          })}
        </div>}
      </>}
    </div>}
  </details>;
}
