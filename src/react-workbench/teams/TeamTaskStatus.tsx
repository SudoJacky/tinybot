import { Check, Circle, CircleAlert, LoaderCircle, LockKeyhole, Pause, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TeamRun, TeamTaskRecord } from "../../app-core/native/desktopNativeTeams";
import { taskState } from "./teamPresentation";

export function TeamRunningIndicator() {
  return <LoaderCircle size={16} className="team-running-indicator" aria-hidden="true" />;
}

export function TeamTaskStatus({ run, record, animate = true }: { run: TeamRun; record: TeamTaskRecord; animate?: boolean }) {
  const { t } = useTranslation("common");
  const state = taskState(run, record);
  const Icon = state === "succeeded" ? Check
    : state === "blocked" ? LockKeyhole
    : state === "paused" ? Pause
    : state === "cancelled" ? Square
    : state === "failed" || state === "interrupted" ? CircleAlert
    : Circle;
  return (
    <span className={`team-status is-${state}`}>
      {state === "running" ? (animate ? <TeamRunningIndicator /> : <span className="team-state-dot" aria-hidden="true" />) : <Icon size={16} aria-hidden="true" />}
      {t(`teams.status.${state}`)}
    </span>
  );
}
