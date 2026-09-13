import { CheckCircle2, Circle, CircleAlert, LoaderCircle, MoreHorizontal, Play } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRun, SavedAutomation } from "../../app-core/native/desktopNativeAutomations";

export function AutomationTaskRow({ definition, latestRun, workspaceName, busy, onEdit, onRun, onHistory }: {
  definition: SavedAutomation;
  latestRun?: AutomationRun;
  workspaceName: string;
  busy: boolean;
  onEdit: () => void;
  onRun: () => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation("common");
  const menu = useRef<HTMLDetailsElement>(null);
  const active = latestRun?.status === "running" || latestRun?.status === "waiting";
  const Icon = latestRun?.status === "completed" ? CheckCircle2
    : latestRun?.status === "running" ? LoaderCircle
    : latestRun && latestRun.status !== "cancelled" ? CircleAlert : Circle;
  return <article className="automation-task-row">
    <button className="automation-task-main" type="button" disabled={busy} onClick={onEdit}>
      <Icon aria-hidden="true" className="automation-task-status" size={20} />
      <span className="automation-task-copy">
        <span className="automation-task-name">{definition.name}</span>
        <span className="automation-task-description">{t(`automations.repeats.${definition.schedule?.repeat ?? "manual"}`)} · {workspaceName}{latestRun ? ` · ${t(`automations.status.${latestRun.status}`)}` : ""}
          {definition.nextRunAtMs && <> · {t("automations.nextRun", { time: new Date(definition.nextRunAtMs).toLocaleString() })}</>}</span>
      </span>
    </button>
    <div className="automation-task-actions">
      <button className="automation-icon-button automation-task-run" type="button" aria-label={t("automations.run")} title={t("automations.run")} disabled={busy || active} onClick={onRun}><Play size={17} /></button>
      <details className="automation-task-menu" ref={menu} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={(event) => {
        if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); event.stopPropagation(); }
      }}>
        <summary aria-label={t("automations.taskOptions", { name: definition.name })} title={t("automations.edit")}><MoreHorizontal size={20} /></summary>
        <div className="react-popover-surface automation-task-popover">
          <button type="button" disabled={busy} onClick={() => { if (menu.current) menu.current.open = false; onEdit(); }}>{t("automations.edit")}</button>
          <button type="button" disabled={busy} onClick={() => { if (menu.current) menu.current.open = false; onHistory(); }}>{t("automations.history")}</button>
        </div>
      </details>
    </div>
  </article>;
}
