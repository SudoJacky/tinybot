import { Check, Loader2, AlertCircle } from "lucide-react";
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
        title={task?.task.title ?? member.instructions}
        onClick={() => task && onSelect(task.task.id)}>
        <TeamMemberAvatar memberId={member.id}>
          <span className="team-dock-state" aria-hidden="true">
            {state === "running" ? <Loader2 size={12} className="team-running-indicator" />
              : state === "succeeded" ? <Check size={12} />
              : ["failed", "interrupted", "cancelled"].includes(state) ? <AlertCircle size={12} /> : null}
          </span>
        </TeamMemberAvatar>
        <strong>{member.displayName}</strong>
        <span>{state === "idle" ? t("teams.idleMember") : t(`teams.status.${state}`)}</span>
      </button>;
    })}
  </nav>;
}
