import { Check, Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  buildAgentDefaultsPatch,
  buildAgentDefaultsSettings,
  listSupportedTimeZones,
  resolveSystemTimeZone,
  validateAgentDefaultsInput,
  type AgentDefaultsFormValues,
  type AgentDefaultsSettingsData,
  type AgentDefaultsValidationErrorCode,
  type AgentDefaultsValidationErrors,
} from "../../app-core/settings/agentDefaultsSettings";
import type { SettingsStore } from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";
import { SettingsSaveStatus, type SettingsSaveState } from "./SettingsSaveStatus";

type AgentDefaultsSettingsPageProps = {
  settingsStore: SettingsStore;
};

export function AgentDefaultsSettingsPage({ settingsStore }: AgentDefaultsSettingsPageProps) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [data, setData] = useState<AgentDefaultsSettingsData | null>(null);
  const [values, setValues] = useState<AgentDefaultsFormValues | null>(null);
  const [errors, setErrors] = useState<AgentDefaultsValidationErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveResultState, setSaveResultState] = useState<SettingsSaveState>("idle");
  const [saving, setSaving] = useState(false);
  const systemTimeZone = useMemo(resolveSystemTimeZone, []);
  const timeZoneOptions = useMemo(
    () => listSupportedTimeZones(values?.timezone, systemTimeZone)
      .map((timeZone) => ({ label: timeZone, value: timeZone })),
    [systemTimeZone, values?.timezone],
  );
  const saveState: SettingsSaveState = saving ? "saving" : saveResultState;

  useEffect(() => {
    let cancelled = false;
    settingsStore.loadAgentDefaultsSettings?.()
      .then((snapshot) => {
        if (!cancelled) {
          setData(snapshot);
          setValues(snapshot.values);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settingsStore]);

  function editValue(field: keyof AgentDefaultsFormValues, value: string) {
    setValues((current) => current ? { ...current, [field]: value } : current);
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveStatus(null);
    setSaveResultState("idle");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !values || !settingsStore.saveAgentDefaultsSettings) {
      return;
    }
    const nextErrors = validateAgentDefaultsInput(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }
    setSaving(true);
    setSaveStatus(t("agent.saving"));
    setSaveResultState("saving");
    try {
      const next = await settingsStore.saveAgentDefaultsSettings(data.currentConfig, buildAgentDefaultsPatch(values));
      const nextData = next.values ? next : buildAgentDefaultsSettings(next.currentConfig);
      setData(nextData);
      setValues(nextData.values);
      setSaveStatus(t("agent.saved"));
      setSaveResultState("saved");
    } catch (error) {
      setSaveStatus(t("agent.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
      setSaveResultState("error");
      throw error;
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data || !values) {
    return <p className="react-empty-state">{t("agent.loading")}</p>;
  }

  return (
    <section className="react-agent-defaults-settings" aria-labelledby="agent-defaults-title">
      <div className="react-provider-settings__header">
        <div>
          <h2 id="agent-defaults-title">{t("agent.title")}</h2>
          <p>{t("agent.description")}</p>
        </div>
      </div>

      <SettingsSaveStatus message={saveStatus} state={saveState} />

      <form className="react-agent-defaults-form" onSubmit={submit}>
        <section aria-labelledby="agent-runtime-title">
          <h3 id="agent-runtime-title">{t("agent.runtime")}</h3>
          <div className="react-agent-defaults-grid">
            <SettingsChoiceList
              description={t("agent.timezoneDescription", { timezone: systemTimeZone })}
              error={validationMessage(t, errors.timezone)}
              label={t("agent.timezone")}
              options={timeZoneOptions}
              value={values.timezone}
              onChange={(value) => editValue("timezone", value)}
            />
            <AgentDefaultInput
              error={validationMessage(t, errors.maxTokens)}
              label={t("agent.maxTokens")}
              value={values.maxTokens}
              onChange={(value) => editValue("maxTokens", value)}
            />
            <SettingsChoiceList
              error={validationMessage(t, errors.contextWindowStrategy)}
              label={t("agent.contextStrategy")}
              options={[
                { value: "discard", label: t("agent.discard"), description: t("agent.discardDescription") },
                { value: "compact", label: t("agent.compact"), description: t("agent.compactDescription") },
              ]}
              value={values.contextWindowStrategy}
              onChange={(value) => editValue("contextWindowStrategy", value)}
            />
            <AgentDefaultInput
              error={validationMessage(t, errors.maxToolIterations)}
              label={t("agent.maxToolIterations")}
              value={values.maxToolIterations}
              onChange={(value) => editValue("maxToolIterations", value)}
            />
          </div>
        </section>
        <footer>
          {data.revision ? <small>{t("agent.revision", { revision: data.revision })}</small> : <span />}
          <button type="submit" aria-label={t("agent.saveLabel")} data-press-feedback="true" disabled={saving}>
            {saving
              ? <Loader2 aria-hidden="true" className="react-settings-spinner" size={15} />
              : <Check aria-hidden="true" size={15} />}
            {saving ? tCommon("generic.saving") : tCommon("generic.save")}
          </button>
        </footer>
      </form>
    </section>
  );
}

function validationMessage(
  t: TFunction<"settings">,
  code?: AgentDefaultsValidationErrorCode,
): string | undefined {
  switch (code) {
    case "timezone": return t("agent.validation.timezone");
    case "max-tokens": return t("agent.validation.maxTokens");
    case "context-strategy": return t("agent.validation.contextStrategy");
    case "max-tool-iterations": return t("agent.validation.maxToolIterations");
    case undefined: return undefined;
  }
}

function AgentDefaultInput({
  error,
  label,
  onChange,
  value,
}: {
  error?: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        aria-describedby={error ? `${label}-error` : undefined}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error ? <small id={`${label}-error`} role="alert">{error}</small> : null}
    </label>
  );
}
