import { useTranslation } from "react-i18next";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { memberTask, taskState } from "./teamPresentation";

export function TeamMemberDock({ run, selectedMemberId, onSelect }: {
  run: TeamRun; selectedMemberId: string; onSelect(taskId: string): void;
}) {
  const { t } = useTranslation("common");
  return <nav className="team-member-dock" aria-label={t("teams.members")}>
    {run.spec.members.map((member) => {
      const task = memberTask(run, member.id);
      const assignments = run.tasks.filter((record) => record.task.memberId === member.id);
      const current = task?.status === "running" ? task
        : assignments.find((record) => ["failed", "interrupted", "cancelled"].includes(record.status))
          ?? assignments.find((record) => record.status === "pending") ?? task;
      const state = current ? taskState(run, current) : "idle";
      return <button key={member.id} className={`team-dock-member is-${state}`}
        disabled={!task} aria-pressed={selectedMemberId === member.id}
        aria-label={task ? t("teams.viewMemberTask", { member: member.displayName, task: task.task.title }) : member.displayName}
        title={`${member.displayName} · ${task?.task.title ?? member.instructions}`}
        onClick={() => task && onSelect(task.task.id)}>
        <TeamMemberAvatar memberId={member.id} />
        <strong>{member.displayName}</strong>
        <span className={`team-status is-${state}`}><span className="team-state-dot" aria-hidden="true" />{state === "idle" ? t("teams.idleMember") : t(`teams.status.${state}`)}</span>
      </button>;
    })}
  </nav>;
}
