import { useTranslation } from "react-i18next";
import { REASONING_EFFORT_VALUES } from "../../app-core/chat/reasoningEffort";
import type { AutomationExecution, AutomationSchedule, SaveAutomation } from "../../app-core/native/desktopNativeAutomations";
import type { ProviderModelsSettingsData } from "../../app-core/settings/providerModelsSettings";
import type { SessionSummary, WorkspaceRegistryEntry } from "../services";

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
const workspaceKey = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
};

export function AutomationSettings({ draft, workspaces, catalog, sessions, busy, onChange }: {
  draft: SaveAutomation; workspaces: WorkspaceRegistryEntry[];
  catalog: ProviderModelsSettingsData; sessions: SessionSummary[]; busy: boolean;
  onChange: (draft: SaveAutomation) => void;
}) {
  const { t } = useTranslation("common");
  const execution = draft.execution ?? {};
  const schedule = draft.schedule ?? { repeat: "manual" };
  const update = (patch: Partial<AutomationExecution>) => onChange({ ...draft, execution: { ...execution, ...patch } });
  const providers = catalog.providers.filter((p) => p.enabled && p.status === "available");
  const provider = providers.find((p) => p.profileId === execution.profile);
  const models = provider?.models.filter((m) => m.enabled) ?? [];
  const availableSessions = sessions.filter((s) => !s.archived && !s.projectCoordinator && s.workingDirectory && workspaceKey(s.workingDirectory) === workspaceKey(draft.workspacePath));
  return <>
    <section className="automation-settings-section" aria-label={t("automations.details")}>
      <h2>{t("automations.details")}</h2>
      <div className="automation-settings-group">
        <label className="automation-setting-row"><span>{t("automations.workspace")}</span>
          <select required value={draft.workspacePath} disabled={busy} onChange={(e) => onChange({ ...draft, workspacePath: e.target.value, execution: { ...execution, threadId: null } })}>
            <option value="">{t("automations.selectWorkspace")}</option>
            {draft.workspacePath && !workspaces.some((w) => w.path === draft.workspacePath) && <option value={draft.workspacePath} disabled>{draft.workspacePath} ({t("automations.missing")})</option>}
            {workspaces.map((w) => <option key={w.path} value={w.path} disabled={!w.exists}>{w.name} · {w.path}{!w.exists ? ` (${t("automations.missing")})` : ""}</option>)}
          </select>
        </label>
        <label className="automation-setting-row"><span>{t("automations.runsIn")}</span>
          <select value={execution.threadId ?? ""} disabled={busy} onChange={(e) => update({ threadId: e.target.value || null })}>
            <option value="">{t("automations.newChatEachRun")}</option>
            {execution.threadId && !availableSessions.some((s) => s.id === execution.threadId) && <option value={execution.threadId} disabled>{t("automations.unavailableConversation")}</option>}
            {availableSessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <label className="automation-setting-row"><span>Provider</span>
          <select value={execution.profile ?? ""} disabled={busy} onChange={(e) => {
            const next = providers.find((p) => p.profileId === e.target.value);
            update({ profile: next?.profileId ?? null, provider: next?.id ?? null,
              model: next ? (next.models.find((m) => m.enabled && m.id === next.defaultModel) ?? next.models.find((m) => m.enabled))?.id ?? null : null,
              reasoningEffort: null });
          }}>
            <option value="">{t("automations.inheritModel")}</option>
            {execution.profile && !provider && <option value={execution.profile} disabled>{execution.profile} ({t("automations.missing")})</option>}
            {providers.map((p) => <option key={p.profileId} value={p.profileId}>{p.label}</option>)}
          </select>
        </label>
        <label className="automation-setting-row"><span>{t("automations.model")}</span>
          <select value={execution.model ?? ""} required={!!execution.profile} disabled={busy || !provider} onChange={(e) => update({ model: e.target.value })}>
            {!provider && <option value={execution.model ?? ""}>{execution.model ?? catalog.agentDefaultModel ?? t("automations.inheritModel")}</option>}
            {provider && execution.model && !models.some((m) => m.id === execution.model) && <option value={execution.model} disabled>{execution.model} ({t("automations.missing")})</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="automation-setting-row"><span>{t("automations.reasoning")}</span>
          <select value={execution.reasoningEffort ?? ""} disabled={busy || provider?.supportsReasoningEffort === false} onChange={(e) => update({ reasoningEffort: e.target.value as AutomationExecution["reasoningEffort"] || null })}>
            <option value="">{t("graphs.reasoningDefault")}</option>
            {REASONING_EFFORT_VALUES.map((effort) => <option key={effort} value={effort}>{t(`graphs.reasoningOptions.${effort}.label`)}</option>)}
          </select>
        </label>
      </div>
      <p className="automation-setting-hint">{t("automations.conversationHint")}</p>
    </section>
    <section className="automation-settings-section" aria-label={t("automations.frequency")}>
      <h2>{t("automations.frequency")}</h2>
      <div className="automation-settings-group">
        <label className="automation-setting-row"><span>{t("automations.repeat")}</span>
          <select value={schedule.repeat} disabled={busy} onChange={(e) => onChange({ ...draft, schedule: { repeat: e.target.value as AutomationSchedule["repeat"], startAtMs: e.target.value === "manual" ? null : schedule.startAtMs ?? Math.ceil((Date.now() + 300_000) / 60_000) * 60_000 } })}>
            {(["manual", "once", "daily", "weekdays", "weekly"] as const).map((repeat) => <option key={repeat} value={repeat}>{t(`automations.repeats.${repeat}`)}</option>)}
          </select>
        </label>
        {schedule.repeat !== "manual" && <label className="automation-setting-row"><span>{t("automations.startsAt")}</span>
          <input type="datetime-local" required disabled={busy} value={schedule.startAtMs ? localDateTime(schedule.startAtMs) : ""} onChange={(e) => onChange({ ...draft, schedule: { ...schedule, startAtMs: e.target.value ? new Date(e.target.value).getTime() : null } })} />
        </label>}
      </div>
      {schedule.repeat !== "manual" && <p className="automation-setting-hint">{t("automations.scheduleHint")}</p>}
    </section>
  </>;
}
