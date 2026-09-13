import { SettingsChoiceList } from "../settings/SettingsChoiceList";
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
        <SettingsChoiceList label={t("automations.workspace")} value={draft.workspacePath} disabled={busy} menuPosition="fixed"
          onChange={(value) => onChange({ ...draft, workspacePath: value, execution: { ...execution, threadId: null } })}
          options={[
            { value: "", label: t("automations.selectWorkspace"), disabled: true },
            ...(draft.workspacePath && !workspaces.some((w) => w.path === draft.workspacePath) ? [{ value: draft.workspacePath, label: draft.workspacePath, description: t("automations.missing"), disabled: true }] : []),
            ...workspaces.map((w) => ({ value: w.path, label: w.name, description: w.path, disabled: !w.exists })),
          ]} />
        <SettingsChoiceList label={t("automations.runsIn")} value={execution.threadId ?? ""} disabled={busy} menuPosition="fixed"
          onChange={(value) => update({ threadId: value || null })}
          options={[
            { value: "", label: t("automations.newChatEachRun") },
            ...(execution.threadId && !availableSessions.some((s) => s.id === execution.threadId) ? [{ value: execution.threadId, label: t("automations.unavailableConversation"), disabled: true }] : []),
            ...availableSessions.map((s) => ({ value: s.id, label: s.title })),
          ]} />
        <SettingsChoiceList label="Provider" value={execution.profile ?? ""} disabled={busy} menuPosition="fixed"
          onChange={(value) => {
            const next = providers.find((p) => p.profileId === value);
            update({ profile: next?.profileId ?? null, provider: next?.id ?? null,
              model: next ? (next.models.find((m) => m.enabled && m.id === next.defaultModel) ?? next.models.find((m) => m.enabled))?.id ?? null : null,
              reasoningEffort: null });
          }}
          options={[
            { value: "", label: t("automations.inheritModel") },
            ...(execution.profile && !provider ? [{ value: execution.profile, label: execution.profile, description: t("automations.missing"), disabled: true }] : []),
            ...providers.map((p) => ({ value: p.profileId, label: p.label })),
          ]} />
        <SettingsChoiceList label={t("automations.model")} value={execution.model ?? ""} disabled={busy || !provider} menuPosition="fixed"
          onChange={(value) => update({ model: value })}
          options={!provider ? [{ value: execution.model ?? "", label: execution.model ?? catalog.agentDefaultModel ?? t("automations.inheritModel") }] : [
            ...(execution.model && !models.some((m) => m.id === execution.model) ? [{ value: execution.model, label: execution.model, description: t("automations.missing"), disabled: true }] : []),
            ...models.map((m) => ({ value: m.id, label: m.label })),
          ]} />
        <SettingsChoiceList label={t("automations.reasoning")} value={execution.reasoningEffort ?? ""} disabled={busy || provider?.supportsReasoningEffort === false} menuPosition="fixed"
          onChange={(value) => update({ reasoningEffort: value as AutomationExecution["reasoningEffort"] || null })}
          options={[
            { value: "", label: t("graphs.reasoningDefault") },
            ...REASONING_EFFORT_VALUES.map((effort) => ({ value: effort, label: t(`graphs.reasoningOptions.${effort}.label`) })),
          ]} />
      </div>
      <p className="automation-setting-hint">{t("automations.conversationHint")}</p>
    </section>
    <section className="automation-settings-section" aria-label={t("automations.frequency")}>
      <h2>{t("automations.frequency")}</h2>
      <div className="automation-settings-group">
        <SettingsChoiceList label={t("automations.repeat")} value={schedule.repeat} disabled={busy} menuPosition="fixed"
          onChange={(value) => onChange({ ...draft, schedule: { repeat: value as AutomationSchedule["repeat"], startAtMs: value === "manual" ? null : schedule.startAtMs ?? Math.ceil((Date.now() + 300_000) / 60_000) * 60_000 } })}
          options={(["manual", "once", "daily", "weekdays", "weekly"] as const).map((repeat) => ({ value: repeat, label: t(`automations.repeats.${repeat}`) }))} />
        {schedule.repeat !== "manual" && <label className="automation-setting-row"><span>{t("automations.startsAt")}</span>
          <input className="react-form-input" type="datetime-local" required disabled={busy} value={schedule.startAtMs ? localDateTime(schedule.startAtMs) : ""} onChange={(e) => onChange({ ...draft, schedule: { ...schedule, startAtMs: e.target.value ? new Date(e.target.value).getTime() : null } })} />
        </label>}
      </div>
      {schedule.repeat !== "manual" && <p className="automation-setting-hint">{t("automations.scheduleHint")}</p>}
    </section>
  </>;
}
