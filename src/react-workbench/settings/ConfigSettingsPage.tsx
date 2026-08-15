import { Check, Loader2, RotateCcw } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  applyDesktopSettingsFieldEdit,
} from "../../app-core/settings/desktopSettingsProviders";
import { buildDesktopSettingsPaneModel } from "../../app-core/settings/desktopSettingsPaneModel";
import { createDesktopSettingsPatch } from "../../app-core/settings/desktopSettingsPersistence";
import type { DesktopSettingsFormState } from "../../app-core/settings/desktopSettingsContracts";
import type { DesktopSettingsPaneField } from "../../app-core/settings/desktopSettingsPaneContracts";
import type {
  DesktopConfigSettingsData,
  DesktopConfigSettingsSaveResult,
  SettingsStore,
} from "../services";
import { SettingsSaveStatus, type SettingsSaveState } from "./SettingsSaveStatus";

export type ConfigSettingsGroupId = "tools-mcp" | "channels";

type ConfigSettingsPageProps = {
  groupId: ConfigSettingsGroupId;
  settingsStore: SettingsStore;
};

const EXPOSED_FIELDS: Record<ConfigSettingsGroupId, readonly string[]> = {
  "tools-mcp": [
    "webEnable",
    "execEnable",
    "webProxy",
    "searchProvider",
    "execTimeout",
    "restrictToWorkspace",
    "mcpServers",
  ],
  channels: ["sendProgress", "sendToolHints", "sendMaxRetries"],
};

export function ConfigSettingsPage({ groupId, settingsStore }: ConfigSettingsPageProps) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [data, setData] = useState<DesktopConfigSettingsData | null>(null);
  const [draft, setDraft] = useState<DesktopSettingsFormState | null>(null);
  const [advancedVisible, setAdvancedVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [statusState, setStatusState] = useState<SettingsSaveState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveState: SettingsSaveState = saving ? "saving" : statusState;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setDraft(null);
    setErrors({});
    setStatus(null);
    setStatusState("idle");
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
  const copy = groupId === "tools-mcp"
    ? { title: t("config.toolsTitle"), description: t("config.toolsDescription") }
    : { title: t("config.channelsTitle"), description: t("config.channelsDescription") };

  function editField(field: DesktopSettingsPaneField, value: string | boolean) {
    if (!draft) {
      return;
    }
    if (field.confirmation && confirmationApplies(field, value) && !window.confirm(confirmationMessage(field, t))) {
      return;
    }
    setDraft(applyDesktopSettingsFieldEdit(draft, field.id, value));
    setErrors((current) => {
      const next = { ...current };
      delete next[field.id];
      return next;
    });
    setStatus(null);
    setStatusState("idle");
  }

  function resetDraft() {
    if (!data) {
      return;
    }
    setDraft(data.formState);
    setErrors({});
    setStatus(null);
    setStatusState("idle");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !draft || !settingsStore.saveDesktopConfigSettings || !group) {
      return;
    }
    const nextErrors = validateGroup(fields, t);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (fields.some((field) => field.advanced && nextErrors[field.id])) {
        setAdvancedVisible(true);
      }
      setStatus(t("config.reviewFields"));
      setStatusState("notice");
      return;
    }
    const patch = createDesktopSettingsPatch(draft, data.currentConfig);
    if (!Object.keys(patch).length) {
      setStatus(t("config.noChanges"));
      setStatusState("notice");
      return;
    }
    setSaving(true);
    setStatus(t("config.saving"));
    setStatusState("saving");
    try {
      const saved = await settingsStore.saveDesktopConfigSettings(data.currentConfig, patch);
      setData(saved);
      setDraft(saved.formState);
      setStatus(formatSaveStatus(saved, t));
      setStatusState("saved");
    } catch (error) {
      setStatus(t("config.saveFailed", { message: errorMessage(error) }));
      setStatusState("error");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data || !draft || !group) {
    return <p className="react-empty-state">{t("config.loading", { section: copy.title })}</p>;
  }

  return (
    <section className="react-config-settings" aria-labelledby={`${groupId}-settings-title`}>
      <header className="react-provider-settings__header">
        <div>
          <h2 id={`${groupId}-settings-title`}>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
        <span className="react-config-settings__persistence">{t("config.persisted")}</span>
      </header>

      <SettingsSaveStatus message={status} state={saveState} />

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
            {advancedVisible ? t("config.hideAdvanced") : t("config.showAdvanced")}
          </button>
        ) : null}

        <footer>
          <div>
            <span>{revisionFromConfig(data.currentConfig, t)}</span>
            {dirty ? <small>{t("config.unsaved")}</small> : <small>{t("config.upToDate")}</small>}
          </div>
          <div>
            <button data-press-feedback="true" type="button" disabled={!dirty || saving} onClick={resetDraft}>
              <RotateCcw aria-hidden="true" size={14} />
              {t("config.reset")}
            </button>
            <button className="react-config-settings__save" data-press-feedback="true" type="submit" disabled={!dirty || saving}>
              {saving
                ? <Loader2 aria-hidden="true" className="react-settings-spinner" size={15} />
                : <Check aria-hidden="true" size={15} />}
              {saving ? tCommon("generic.saving") : t("config.saveChanges")}
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
  const { t } = useTranslation("settings");
  const copy = configFieldCopy(field, t);
  if (field.control === "checkbox") {
    return (
      <label className="react-config-settings__toggle" data-disabled={field.disabled || undefined}>
        <span>
          <strong>{copy.label}</strong>
          {copy.description ? <small>{copy.description}</small> : null}
          {field.notice ? <small className="react-config-settings__notice">{field.notice}</small> : null}
        </span>
        <input
          aria-label={copy.label}
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
        <strong>{copy.label}</strong>
        {field.advanced ? <em>{t("config.advanced")}</em> : null}
      </span>
      {copy.description ? <small>{copy.description}</small> : null}
      {field.control === "select" ? (
        <select
          aria-label={copy.label}
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
          aria-label={copy.label}
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
            aria-label={copy.label}
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

const CONFIG_FIELD_IDS = new Set([
  "execEnable",
  "execTimeout",
  "mcpServers",
  "restrictToWorkspace",
  "searchProvider",
  "sendMaxRetries",
  "sendProgress",
  "sendToolHints",
  "webEnable",
  "webProxy",
]);

function configFieldCopy(
  field: DesktopSettingsPaneField,
  t: TFunction<"settings">,
): { description?: string; label: string } {
  if (!CONFIG_FIELD_IDS.has(field.id)) {
    return { description: field.description, label: field.label };
  }
  const fieldId = field.id as
    | "execEnable"
    | "execTimeout"
    | "mcpServers"
    | "restrictToWorkspace"
    | "searchProvider"
    | "sendMaxRetries"
    | "sendProgress"
    | "sendToolHints"
    | "webEnable"
    | "webProxy";
  return {
    description: t(`config.fields.${fieldId}`),
    label: t(`config.fieldLabels.${fieldId}`),
  };
}

function confirmationMessage(field: DesktopSettingsPaneField, t: TFunction<"settings">): string {
  if (field.id === "execEnable") {
    return t("config.confirmation.execEnable");
  }
  if (field.id === "restrictToWorkspace") {
    return t("config.confirmation.restrictToWorkspace");
  }
  return field.confirmation?.message ?? "";
}

function validateGroup(fields: DesktopSettingsPaneField[], t: TFunction<"settings">): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.disabled || field.control === "readonly") {
      continue;
    }
    if (field.state === "invalid") {
      errors[field.id] = invalidFieldMessage(field, t);
      continue;
    }
    if (field.requirement === "required" && !field.inputValue.trim()) {
      errors[field.id] = t("config.required", { label: configFieldCopy(field, t).label });
      continue;
    }
    if (field.control === "number" && field.inputValue.trim()) {
      const value = Number(field.inputValue);
      if (!Number.isFinite(value)) {
        errors[field.id] = t("config.number", { label: configFieldCopy(field, t).label });
      } else if (field.min !== undefined && value < field.min) {
        errors[field.id] = t("config.minimum", { label: configFieldCopy(field, t).label, min: field.min });
      } else if (field.max !== undefined && value > field.max) {
        errors[field.id] = t("config.maximum", { label: configFieldCopy(field, t).label, max: field.max });
      }
    }
  }
  return errors;
}

function invalidFieldMessage(field: DesktopSettingsPaneField, t: TFunction<"settings">): string {
  const label = configFieldCopy(field, t).label;
  if (field.id === "mcpServers") {
    return t("config.invalidJson", { label });
  }
  if (field.configurationMode === "url") {
    return t("config.invalidUrl", { label });
  }
  return t("config.invalid", { label });
}

function confirmationApplies(field: DesktopSettingsPaneField, value: string | boolean): boolean {
  if (!field.confirmation || typeof value !== "boolean") {
    return false;
  }
  return field.confirmation.when === "change"
    || (field.confirmation.when === "enable" && value)
    || (field.confirmation.when === "disable" && !value);
}

function formatSaveStatus(saved: DesktopConfigSettingsSaveResult, t: TFunction<"settings">): string {
  if (saved.saveDetails.restartRequired.length) {
    return t("config.savedRestart");
  }
  if (saved.saveDetails.reloadRequired.length) {
    return t("config.savedReload");
  }
  return t("config.saved");
}

function revisionFromConfig(config: unknown, t: TFunction<"settings">): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return t("config.revisionUnavailable");
  }
  const record = config as Record<string, unknown>;
  const revision = record.revision;
  return typeof revision === "string" && revision
    ? t("config.revision", { revision })
    : t("config.revisionUnavailable");
}

function friendlyOptionLabel(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
