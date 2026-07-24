import { ArrowUpRight, Check } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  buildAgentDefaultsPatch,
  buildAgentDefaultsSettings,
  validateAgentDefaultsInput,
  type AgentDefaultsFormValues,
  type AgentDefaultsSettingsData,
  type AgentDefaultsValidationErrors,
} from "../../app-core/settings/agentDefaultsSettings";
import type { SettingsStore } from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";

type AgentDefaultsSettingsPageProps = {
  onNavigateToProviderModels: () => void;
  settingsStore: SettingsStore;
};

export function AgentDefaultsSettingsPage({ onNavigateToProviderModels, settingsStore }: AgentDefaultsSettingsPageProps) {
  const [data, setData] = useState<AgentDefaultsSettingsData | null>(null);
  const [values, setValues] = useState<AgentDefaultsFormValues | null>(null);
  const [errors, setErrors] = useState<AgentDefaultsValidationErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
    setSaveStatus("Saving...");
    try {
      const next = await settingsStore.saveAgentDefaultsSettings(data.currentConfig, buildAgentDefaultsPatch(values));
      const nextData = next.values ? next : buildAgentDefaultsSettings(next.currentConfig);
      setData(nextData);
      setValues(nextData.values);
      setSaveStatus("Saved");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data || !values) {
    return <p className="react-empty-state">Loading agent defaults...</p>;
  }

  return (
    <section className="react-agent-defaults-settings" aria-labelledby="agent-defaults-title">
      <div className="react-provider-settings__header">
        <div>
          <h2 id="agent-defaults-title">Agent Defaults</h2>
          <p>Runtime defaults apply to new chat and agent turns unless a specific Agent overrides them.</p>
        </div>
      </div>

      <section className="react-settings-linked-summary" aria-labelledby="agent-default-model-title">
        <div>
          <h3 id="agent-default-model-title">Default LLM</h3>
          <p>Change the active profile and default model from Provider & Models.</p>
        </div>
        <dl>
          <div>
            <dt>Active profile</dt>
            <dd>{data.activeProfileId ?? "Not configured"}</dd>
          </div>
          <div>
            <dt>Default model</dt>
            <dd>{data.defaultModel ?? "Not configured"}</dd>
          </div>
        </dl>
        <button type="button" aria-label="Change default model in Provider & Models" onClick={onNavigateToProviderModels}>
          <span>Provider & Models</span>
          <ArrowUpRight aria-hidden="true" size={15} />
        </button>
      </section>

      {saveStatus ? <p className="react-settings-save-status" role="status">{saveStatus}</p> : null}

      <form className="react-agent-defaults-form" onSubmit={submit}>
        <section aria-labelledby="agent-runtime-title">
          <h3 id="agent-runtime-title">Runtime</h3>
          <div className="react-agent-defaults-grid">
            <AgentDefaultInput
              error={errors.timezone}
              label="Timezone"
              value={values.timezone}
              onChange={(value) => editValue("timezone", value)}
            />
            <AgentDefaultInput
              error={errors.temperature}
              label="Temperature"
              value={values.temperature}
              onChange={(value) => editValue("temperature", value)}
            />
            <AgentDefaultInput
              error={errors.maxTokens}
              label="Max output tokens"
              value={values.maxTokens}
              onChange={(value) => editValue("maxTokens", value)}
            />
            <AgentDefaultInput
              error={errors.contextWindowTokens}
              label="Context window budget"
              value={values.contextWindowTokens}
              onChange={(value) => editValue("contextWindowTokens", value)}
            />
            <SettingsChoiceList
              error={errors.contextWindowStrategy}
              label="Context window strategy"
              options={[
                { value: "discard", label: "Discard old messages", description: "Keep the active context lean." },
                { value: "compact", label: "Compact old messages", description: "Summarize older turns before trimming." },
              ]}
              value={values.contextWindowStrategy}
              onChange={(value) => editValue("contextWindowStrategy", value)}
            />
            <AgentDefaultInput
              error={errors.maxToolIterations}
              label="Max tool iterations"
              value={values.maxToolIterations}
              onChange={(value) => editValue("maxToolIterations", value)}
            />
            <SettingsChoiceList
              label="Reasoning effort"
              options={[
                { value: "", label: "Default", description: "Use the model provider default." },
                { value: "low", label: "Low", description: "Faster, lighter reasoning." },
                { value: "medium", label: "Medium", description: "Balanced reasoning depth." },
                { value: "high", label: "High", description: "More deliberate reasoning." },
              ]}
              value={values.reasoningEffort}
              onChange={(value) => editValue("reasoningEffort", value)}
            />
          </div>
        </section>
        <footer>
          {data.revision ? <small>Config revision {data.revision}</small> : <span />}
          <button type="submit" aria-label="Save agent defaults" disabled={saving}>
            <Check aria-hidden="true" size={15} />
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </form>
    </section>
  );
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
