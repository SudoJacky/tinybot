import { LoadingState } from "../lib/LoadingState";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { LiquidToggle } from "../../components/ui/LiquidToggle";
import type { TFunction } from "i18next";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  configSettingsFields,
  createDesktopConfigSettingsPatch,
  isDesktopConfigSettingsDirty,
  validateDesktopConfigSettings,
  type ConfigSettingsGroupId,
  type ConfigSettingsField,
  type DesktopConfigSettingsValues,
} from "../../app-core/settings/desktopConfigSettings";
import type {
  DesktopConfigSettingsData,
  DesktopConfigSettingsSaveResult,
  SettingsStore,
} from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";
import { SettingsSaveStatus, type SettingsSaveState } from "./SettingsSaveStatus";

export type { ConfigSettingsGroupId } from "../../app-core/settings/desktopConfigSettings";

type ConfigSettingsPageProps = {
  groupId: ConfigSettingsGroupId;
  settingsStore: SettingsStore;
};

export function ConfigSettingsPage({ groupId, settingsStore }: ConfigSettingsPageProps) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [data, setData] = useState<DesktopConfigSettingsData | null>(null);
  const [draft, setDraft] = useState<DesktopConfigSettingsValues | null>(null);
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
    settingsStore.loadDesktopConfigSettings()
      .then((snapshot) => {
        if (!cancelled) {
          setData(snapshot);
          setDraft(snapshot.values);
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

  const fields = configSettingsFields(groupId);
  const visibleFields = fields.filter((field) => advancedVisible || !field.advanced);
  const hasAdvancedFields = fields.some((field) => field.advanced);
  const dirty = Boolean(draft && data && isDesktopConfigSettingsDirty(draft, data.values, groupId));
  const copy = groupId === "tools-mcp"
    ? { title: t("config.toolsTitle"), description: t("config.toolsDescription") }
    : { title: t("config.channelsTitle"), description: t("config.channelsDescription") };

  function editField(field: ConfigSettingsField, value: string | boolean) {
    if (!draft) {
      return;
    }
    if (field.confirmWhen && confirmationApplies(field, value) && !window.confirm(confirmationMessage(field, t))) {
      return;
    }
    setDraft({ ...draft, [field.id]: value });
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
    setDraft(data.values);
    setErrors({});
    setStatus(null);
    setStatusState("idle");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !draft) {
      return;
    }
    const nextErrors = validateGroup(draft, groupId, t);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      if (fields.some((field) => field.advanced && nextErrors[field.id])) {
        setAdvancedVisible(true);
      }
      setStatus(t("config.reviewFields"));
      setStatusState("notice");
      return;
    }
    const patch = createDesktopConfigSettingsPatch(draft, data.values, groupId);
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
      setDraft(saved.values);
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
  if (!data || !draft) {
    return <LoadingState label={t("config.loading", { section: copy.title })} />;
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
              value={draft[field.id]}
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
  value,
  onChange,
}: {
  error?: string;
  field: ConfigSettingsField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const copy = configFieldCopy(field, t);
  if (field.control === "checkbox") {
    return (
      <label className="react-config-settings__toggle">
        <span>
          <strong>{copy.label}</strong>
          {copy.description ? <small>{copy.description}</small> : null}
        </span>
        <LiquidToggle
          aria-label={copy.label}
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </label>
    );
  }

  if (field.control === "select") {
    return (
      <SettingsChoiceList
        badge={field.advanced ? t("config.advanced") : undefined}
        description={copy.description}
        error={error}
        label={copy.label}
        onChange={onChange}
        options={(field.options ?? []).map((option) => ({
          label: friendlyOptionLabel(option),
          value: option,
        }))}
        value={String(value)}
      />
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
      {field.control === "textarea" ? (
        <textarea
          aria-label={copy.label}
          id={controlId}
          aria-invalid={Boolean(error)}
          placeholder={field.placeholder}
          rows={8}
          value={String(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <div className="react-config-settings__input-wrap">
          <input
            aria-label={copy.label}
            id={controlId}
            aria-invalid={Boolean(error)}
            max={field.max}
            min={field.min}
            placeholder={field.placeholder}
            step={field.step}
            type={field.control === "number" ? "number" : "text"}
            value={String(value)}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
      )}
      {error ? <small className="react-config-settings__error" role="alert">{error}</small> : null}
    </label>
  );
}

function configFieldCopy(field: ConfigSettingsField, t: TFunction<"settings">) {
  return {
    description: t(`config.fields.${field.id}`),
    label: t(`config.fieldLabels.${field.id}`),
  };
}

function confirmationMessage(field: ConfigSettingsField, t: TFunction<"settings">): string {
  if (field.id === "execEnable") {
    return t("config.confirmation.execEnable");
  }
  if (field.id === "restrictToWorkspace") {
    return t("config.confirmation.restrictToWorkspace");
  }
  throw new Error(`Unexpected confirmation field: ${field.id}`);
}

function validateGroup(values: DesktopConfigSettingsValues, groupId: ConfigSettingsGroupId, t: TFunction<"settings">): Record<string, string> {
  const errors = validateDesktopConfigSettings(values, groupId);
  const messages: Record<string, string> = {};
  for (const field of configSettingsFields(groupId)) {
    const error = errors[field.id];
    const label = configFieldCopy(field, t).label;
    if (error === "minimum") messages[field.id] = t("config.minimum", { label, min: field.min! });
    else if (error === "maximum") messages[field.id] = t("config.maximum", { label, max: field.max! });
    else if (error) messages[field.id] = t(`config.${error}`, { label });
  }
  return messages;
}

function confirmationApplies(field: ConfigSettingsField, value: string | boolean): boolean {
  if (!field.confirmWhen || typeof value !== "boolean") {
    return false;
  }
  return field.confirmWhen === "enable" ? value : !value;
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

function friendlyOptionLabel(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
