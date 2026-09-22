import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamActivity as Activity } from "./useTeamActivity";

export function TeamActivity({ activity, onRefresh }: { activity?: Activity; onRefresh(): void }) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const items = activity?.items ?? [];
  function rows(start: number, end?: number) {
    return items.slice(start, end).map((item) => <li key={item.id}>
      <span className={`team-status is-${item.status}`}>{t(`teams.activityStatus.${item.status}`)}</span>
      <span>{item.text}</span>
    </li>);
  }
  return <section className="team-activity" aria-label={t("teams.recentActivity")}>
    <h3>{t("teams.recentActivity")}</h3>
    {activity?.error && <div className="team-error" role="alert">
      {activity.error}<button onClick={onRefresh}>{t("teams.refresh")}</button>
    </div>}
    {!items.length && <p>{t(activity?.loading ? "teams.loading" : "teams.noActivity")}</p>}
    {items.length > 5 && <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>{t("teams.earlierActivity", { count: items.length - 5 })}</summary>
      {expanded && <ol>{rows(0, -5)}</ol>}
    </details>}
    <ol>{rows(-5)}</ol>
  </section>;
}
