import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PersonalizationInstructionsData, SettingsStore } from "../services";
import { SettingsSaveStatus, type SettingsSaveState } from "./SettingsSaveStatus";

const MAX_PERSONALIZATION_BYTES = 64 * 1024;

export function PersonalizationSettingsPage({ settingsStore }: { settingsStore: SettingsStore }) {
  const { t } = useTranslation("settings");
  const [data, setData] = useState<PersonalizationInstructionsData | null>(null);
  const [draft, setDraft] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveResultState, setSaveResultState] = useState<SettingsSaveState>("idle");
  const [saving, setSaving] = useState(false);
  const byteLength = new TextEncoder().encode(draft).byteLength;
  const tooLarge = byteLength > MAX_PERSONALIZATION_BYTES;
  const dirty = Boolean(data && draft !== data.contents);
  const saveState: SettingsSaveState = saving ? "saving" : saveResultState;

  useEffect(() => {
    let cancelled = false;
    const load = settingsStore.loadPersonalizationInstructions;
    if (!load) {
      setLoadError(t("personalization.unavailable"));
      return () => {
        cancelled = true;
      };
    }
    setLoadError(null);
    void load.call(settingsStore).then((snapshot) => {
      if (!cancelled) {
        setData(snapshot);
        setDraft(snapshot.contents);
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setLoadError(t("personalization.loadFailed", { message: errorMessage(error) }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadRevision, settingsStore, t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const save = settingsStore.savePersonalizationInstructions;
    if (!data || !save || !dirty || tooLarge) {
      return;
    }
    const contents = draft;
    setSaving(true);
    setSaveMessage(t("personalization.saving"));
    setSaveResultState("saving");
    try {
      const saved = await save.call(settingsStore, {
        contents,
        ...(data.updatedAt ? { expectedUpdatedAt: data.updatedAt } : {}),
      });
      setData(saved);
      setDraft(saved.contents);
      setSaveMessage(t("personalization.saved"));
      setSaveResultState("saved");
    } catch (error) {
      setSaveMessage(t("personalization.saveFailed", { message: errorMessage(error) }));
      setSaveResultState("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="react-personalization-settings react-config-settings" aria-labelledby="personalization-settings-title">
      <div className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("personalization.eyebrow")}</span>
          <h2 id="personalization-settings-title">{t("personalization.title")}</h2>
          <p>{t("personalization.description")}</p>
        </div>
      </div>

      {loadError ? (
        <div className="react-personalization-settings__load-error">
          <SettingsSaveStatus message={loadError} state="error" />
          <button type="button" onClick={() => setLoadRevision((current) => current + 1)}>
            {t("personalization.retry")}
          </button>
        </div>
      ) : !data ? (
        <p className="react-empty-state">{t("personalization.loading")}</p>
      ) : (
        <>
          <SettingsSaveStatus message={saveMessage} state={saveState} />
          <form className="react-config-settings__form" onSubmit={submit}>
            <div className="react-config-settings__fields">
              <label className="react-config-settings__field react-config-settings__field--wide">
                <span>
                  <strong>{t("personalization.customInstructions")}</strong>
                  <em>{data.path}</em>
                </span>
                <small id="personalization-instructions-help">{t("personalization.help")}</small>
                <textarea
                  aria-label={t("personalization.customInstructions")}
                  aria-describedby="personalization-instructions-help"
                  aria-invalid={tooLarge || undefined}
                  disabled={saving}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setSaveMessage(null);
                    setSaveResultState("idle");
                  }}
                  value={draft}
                />
                {tooLarge ? (
                  <small className="react-config-settings__error" role="alert">
                    {t("personalization.tooLarge", { size: byteLength.toLocaleString() })}
                  </small>
                ) : null}
              </label>
            </div>
            <footer>
              <div>
                <span>{t("personalization.source", { path: data.path })}</span>
                <small>{t("personalization.nextTurn")}</small>
              </div>
              <button
                className="react-config-settings__save"
                data-press-feedback="true"
                disabled={!dirty || saving || tooLarge}
                type="submit"
              >
                {saving ? t("personalization.savingButton") : t("personalization.save")}
              </button>
            </footer>
          </form>
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
