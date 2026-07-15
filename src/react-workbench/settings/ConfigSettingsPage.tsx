import { Check, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  applyDesktopSettingsFieldEdit,
  buildDesktopSettingsPaneModel,
  createDesktopSettingsPatch,
  type DesktopSettingsFormState,
  type DesktopSettingsPaneField,
} from "../../app-core/settings/desktopSettingsProviders";
import type {
  DesktopConfigSettingsData,
  DesktopConfigSettingsSaveResult,
  SettingsStore,
} from "../services";

export type ConfigSettingsGroupId = "tools-approvals" | "channels" | "gateway-runtime";

type ConfigSettingsPageProps = {
  groupId: ConfigSettingsGroupId;
  settingsStore: SettingsStore;
};

const GROUP_COPY: Record<ConfigSettingsGroupId, { title: string; description: string }> = {
  "tools-approvals": {
    title: "Tools & MCP",
    description: "Configure built-in tools, workspace boundaries, and raw MCP server definitions.",
  },
  channels: {
    title: "Channels",
    description: "Choose which progress signals are emitted and how failed deliveries are retried.",
  },
  "gateway-runtime": {
    title: "Gateway & Runtime",
    description: "Manage the desktop-owned local gateway port and heartbeat behavior.",
  },
};

const FIELD_COPY: Record<string, string> = {
  webEnable: "Allow agents to use configured web tools.",
  execEnable: "Allow agents to execute local commands. Enable only for trusted workspaces.",
  webProxy: "Optional HTTP proxy for web requests.",
  searchProvider: "Default search backend used by web search tools.",
  execTimeout: "Maximum runtime for one command, in seconds.",
  restrictToWorkspace: "Keep local command and file access inside the active workspace.",
  mcpServers: "JSON object containing MCP server definitions. Secrets should reference environment variables.",
  sendProgress: "Send intermediate progress events to connected clients.",
  sendToolHints: "Include tool activity hints with progress events.",
  sendMaxRetries: "Maximum delivery retries after a channel send failure.",
  port: "TCP port used by the local Tinybot gateway. Changing it requires a gateway restart.",
  heartbeat: "Send a periodic heartbeat while the gateway is running.",
  heartbeatIntervalS: "Seconds between heartbeat events.",
};

const EXPOSED_FIELDS: Record<ConfigSettingsGroupId, readonly string[]> = {
  "tools-approvals": [
    "webEnable",
    "execEnable",
    "webProxy",
    "searchProvider",
    "execTimeout",
    "restrictToWorkspace",
    "mcpServers",
  ],
  channels: ["sendProgress", "sendToolHints", "sendMaxRetries"],
  "gateway-runtime": ["port", "heartbeat", "heartbeatIntervalS"],
};

export function ConfigSettingsPage({ groupId, settingsStore }: ConfigSettingsPageProps) {
  const [data, setData] = useState<DesktopConfigSettingsData | null>(null);
  const [draft, setDraft] = useState<DesktopSettingsFormState | null>(null);
  const [advancedVisible, setAdvancedVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setDraft(null);
    setErrors({});
    setStatus(null);
    settingsStore.loadDesktopConfigSettings?.()
      .then((snapshot) => {
        if (!cancelled) {
          setData(snapshot);
          setDraft(snapshot.formState);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, settingsStore]);

  const pane = useMemo(() => {
    if (!data || !draft) {
      return null;
    }
    return buildDesktopSettingsPaneModel(draft, { lastSavedState: data.formState });
  }, [data, draft]);
  const group = pane?.groups.find((candidate) => candidate.id === groupId) ?? null;
  const fields = group?.fields.filter((field) => EXPOSED_FIELDS[groupId].includes(field.id)) ?? [];
  const visibleFields = fields.filter((field) => advancedVisible || !field.advanced);
  const hasAdvancedFields = fields.some((field) => field.advanced);
  const dirty = pane?.dirty === true;
  const copy = GROUP_COPY[groupId];

  function editField(field: DesktopSettingsPaneField, value: string | boolean) {
    if (!draft) {
      return;
    }
    if (field.confirmation && confirmationApplies(field, value) && !window.confirm(field.confirmation.message)) {
      return;
    }
    setDraft(applyDesktopSettingsFieldEdit(draft, field.id, value));
    setErrors((current) => {
      const next = { ...current };
      delete next[field.id];
      return next;
    });
    setStatus(null);
  }

  function resetDraft() {
    if (!data) {
      return;
    }
    setDraft(data.formState);
    setErrors({});
    setStatus(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !draft || !settingsStore.saveDesktopConfigSettings || !group) {
      return;
    }
    const nextErrors = validateGroup(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (fields.some((field) => field.advanced && nextErrors[field.id])) {
        setAdvancedVisible(true);
      }
      setStatus("Review the highlighted fields before saving.");
      return;
    }
    const patch = createDesktopSettingsPatch(draft, data.currentConfig);
    if (!Object.keys(patch).length) {
      setStatus("No changes to save.");
      return;
    }
    setSaving(true);
    setStatus("Saving…");
    try {
      const saved = await settingsStore.saveDesktopConfigSettings(data.currentConfig, patch);
      setData(saved);
      setDraft(saved.formState);
      setStatus(formatSaveStatus(saved));
    } catch (error) {
      setStatus(`Save failed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data || !draft || !group) {
    return <p className="react-empty-state">Loading {copy.title.toLowerCase()} settings…</p>;
  }

  return (
    <section className="react-config-settings" aria-labelledby={`${groupId}-settings-title`}>
      <header className="react-provider-settings__header">
        <div>
          <h2 id={`${groupId}-settings-title`}>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
        <span className="react-config-settings__persistence">Saved to Tinybot config</span>
      </header>

      {status ? <p className="react-settings-save-status" role="status">{status}</p> : null}

      <form className="react-config-settings__form" onSubmit={submit}>
        <div className="react-config-settings__fields">
          {visibleFields.map((field) => (
            <ConfigField
              error={errors[field.id]}
              field={field}
              key={field.id}
              onChange={(value) => editField(field, value)}
            />
          ))}
        </div>

        {hasAdvancedFields ? (
          <button
            className="react-config-settings__advanced-toggle"
            type="button"
            onClick={() => setAdvancedVisible((visible) => !visible)}
          >
            {advancedVisible ? "Hide advanced settings" : "Show advanced settings"}
          </button>
        ) : null}

        <footer>
          <div>
            <span>{revisionFromConfig(data.currentConfig)}</span>
            {dirty ? <small>Unsaved changes</small> : <small>Up to date</small>}
          </div>
          <div>
            <button type="button" disabled={!dirty || saving} onClick={resetDraft}>
              <RotateCcw aria-hidden="true" size={14} />
              Reset
            </button>
            <button className="react-config-settings__save" type="submit" disabled={!dirty || saving}>
              <Check aria-hidden="true" size={15} />
              {saving ? "Saving" : "Save changes"}
            </button>
          </div>
        </footer>
      </form>
    </section>
  );
}

function ConfigField({
  error,
  field,
  onChange,
}: {
  error?: string;
  field: DesktopSettingsPaneField;
  onChange: (value: string | boolean) => void;
}) {
  const description = field.description || FIELD_COPY[field.id];
  if (field.control === "checkbox") {
    return (
      <label className="react-config-settings__toggle" data-disabled={field.disabled || undefined}>
        <span>
          <strong>{field.label}</strong>
          {description ? <small>{description}</small> : null}
          {field.notice ? <small className="react-config-settings__notice">{field.notice}</small> : null}
        </span>
        <input
          aria-label={field.label}
          checked={field.checked === true}
          disabled={field.disabled}
          type="checkbox"
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <i aria-hidden="true" />
      </label>
    );
  }

  const controlId = `config-setting-${field.id}`;
  return (
    <label className={field.control === "textarea" ? "react-config-settings__field react-config-settings__field--wide" : "react-config-settings__field"}>
      <span>
        <strong>{field.label}</strong>
        {field.advanced ? <em>Advanced</em> : null}
      </span>
      {description ? <small>{description}</small> : null}
      {field.control === "select" ? (
        <select
          aria-label={field.label}
          id={controlId}
          disabled={field.disabled}
          value={field.inputValue}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{friendlyOptionLabel(option.label)}</option>
          ))}
        </select>
      ) : field.control === "textarea" ? (
        <textarea
          aria-label={field.label}
          id={controlId}
          aria-invalid={Boolean(error)}
          disabled={field.disabled}
          placeholder={field.placeholder}
          rows={8}
          value={field.inputValue}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <div className="react-config-settings__input-wrap">
          <input
            aria-label={field.label}
            id={controlId}
            aria-invalid={Boolean(error)}
            disabled={field.disabled}
            max={field.max}
            min={field.min}
            placeholder={field.placeholder}
            step={field.step}
            type={field.control === "number" ? "number" : "text"}
            value={field.inputValue}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {field.unit ? <span>{field.unit}</span> : null}
        </div>
      )}
      {error ? <small className="react-config-settings__error" role="alert">{error}</small> : null}
    </label>
  );
}

function validateGroup(fields: DesktopSettingsPaneField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.disabled || field.control === "readonly") {
      continue;
    }
    if (field.state === "invalid") {
      errors[field.id] = invalidFieldMessage(field);
      continue;
    }
    if (field.requirement === "required" && !field.inputValue.trim()) {
      errors[field.id] = `${field.label} is required.`;
      continue;
    }
    if (field.control === "number" && field.inputValue.trim()) {
      const value = Number(field.inputValue);
      if (!Number.isFinite(value)) {
        errors[field.id] = `${field.label} must be a number.`;
      } else if (field.min !== undefined && value < field.min) {
        errors[field.id] = `${field.label} must be at least ${field.min}.`;
      } else if (field.max !== undefined && value > field.max) {
        errors[field.id] = `${field.label} must be at most ${field.max}.`;
      }
    }
  }
  return errors;
}

function invalidFieldMessage(field: DesktopSettingsPaneField): string {
  if (field.id === "mcpServers") {
    return "MCP servers must be a valid JSON object.";
  }
  if (field.id === "port") {
    return "Gateway port must be an integer between 1 and 65535.";
  }
  if (field.configurationMode === "url") {
    return `${field.label} must be a valid URL.`;
  }
  return `${field.label} is invalid.`;
}

function confirmationApplies(field: DesktopSettingsPaneField, value: string | boolean): boolean {
  if (!field.confirmation || typeof value !== "boolean") {
    return false;
  }
  return field.confirmation.when === "change"
    || (field.confirmation.when === "enable" && value)
    || (field.confirmation.when === "disable" && !value);
}

function formatSaveStatus(saved: DesktopConfigSettingsSaveResult): string {
  if (saved.saveDetails.restartRequired.length) {
    return "Saved. Restart the Tinybot gateway to apply this change.";
  }
  if (saved.saveDetails.reloadRequired.length) {
    return "Saved. Reload the active workspace to apply this change.";
  }
  return saved.saveDetails.transport === "native" ? "Saved to Tinybot config." : "Saved through the gateway.";
}

function revisionFromConfig(config: unknown): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "Config revision unavailable";
  }
  const record = config as Record<string, unknown>;
  const revision = record.revision;
  return typeof revision === "string" && revision ? `Config revision ${revision}` : "Config revision unavailable";
}

function friendlyOptionLabel(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
