import { useEffect, useState } from "react";
import { Check, Circle, CircleAlert, LoaderCircle, LockKeyhole, Pause, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TeamAttempt, TeamRun, TeamTaskRecord } from "../../app-core/native/desktopNativeTeams";
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

export function TeamElapsedTime({ attempt }: { attempt: TeamAttempt }) {
  const { t } = useTranslation("common");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (attempt.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [attempt.status, attempt.startedAt]);
  const seconds = Math.max(0, Math.floor(
    ((attempt.finishedAt ? Date.parse(attempt.finishedAt) : now) - Date.parse(attempt.startedAt)) / 1000,
  ));
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <span className="team-elapsed">{t("teams.elapsed", { duration })}</span>;
}
