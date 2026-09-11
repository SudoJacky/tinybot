import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { actionFusionSettingsPatch, readExperimentalSettings, type ExperimentalSettings } from "../../app-core/settings/experimentalSettings";
import type { SettingsStore } from "../services";
import { SettingsSaveStatus } from "./SettingsSaveStatus";

type SaveState = { state: "idle" | "saving" | "saved" } | { state: "error"; error: string };

export function LabsSettingsPage({ settingsStore }: { settingsStore: SettingsStore }) {
  const { t } = useTranslation("settings");
  const [loaded, setLoaded] = useState<{ config: unknown; settings: ExperimentalSettings } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    setSave({ state: "idle" });
    async function load() {
      try {
        if (!settingsStore.loadDesktopConfigSettings || !settingsStore.saveDesktopConfigSettings) {
          throw new Error("Experimental settings are unavailable in this runtime");
        }
        const { currentConfig } = await settingsStore.loadDesktopConfigSettings();
        const settings = readExperimentalSettings(currentConfig);
        if (!cancelled) setLoaded({ config: currentConfig, settings });
      } catch (error) {
        console.error("[tinybot-labs] load failed", error);
        if (!cancelled) setLoadError(errorMessage(error));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [attempt, settingsStore]);

  async function toggleActionFusion(enabled: boolean) {
    if (!loaded || save.state === "saving" || !settingsStore.saveDesktopConfigSettings) return;
    setSave({ state: "saving" });
    try {
      const { currentConfig } = await settingsStore.saveDesktopConfigSettings(loaded.config, actionFusionSettingsPatch(enabled));
      const settings = readExperimentalSettings(currentConfig);
      if (settings.actionFusion !== enabled) throw new Error("Saved Action Fusion setting does not match the requested value");
      setLoaded({ config: currentConfig, settings });
      setSave({ state: "saved" });
    } catch (error) {
      console.error("[tinybot-labs] save failed", error);
      setSave({ state: "error", error: errorMessage(error) });
    }
  }

  return (
    <section className="react-labs-settings" aria-labelledby="labs-settings-title">
      <header className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("labs.eyebrow")}</span>
          <h2 id="labs-settings-title">{t("labs.title")}</h2>
          <p>{t("labs.description")}</p>
        </div>
      </header>

      {loadError ? (
        <div>
          <p role="alert">{t("labs.loadFailed", { message: loadError })}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("labs.reload")}</button>
        </div>
      ) : !loaded ? (
        <p className="react-empty-state" role="status">{t("labs.loading")}</p>
      ) : (
        <div className="react-config-settings__form" aria-busy={save.state === "saving"}>
          <div className="react-config-settings__fields">
            <label className="react-config-settings__toggle">
              <span>
                <strong>{t("labs.actionFusion.title")}</strong>
                <small id="action-fusion-help">{t("labs.actionFusion.description")}</small>
              </span>
              <input
                type="checkbox"
                aria-label={t("labs.actionFusion.title")}
                aria-describedby="action-fusion-help action-fusion-limits"
                checked={loaded.settings.actionFusion}
                disabled={save.state === "saving"}
                onChange={(event) => void toggleActionFusion(event.currentTarget.checked)}
              />
              <i aria-hidden="true" />
            </label>
          </div>
          <small id="action-fusion-limits" className="react-config-settings__persistence">{t("labs.actionFusion.limits")}</small>
          <small className="react-config-settings__persistence">{t("labs.nextTurn")}</small>
          <SettingsSaveStatus
            state={save.state}
            message={save.state === "idle" ? null : save.state === "error" ? t("labs.saveFailed", { message: save.error }) : t(`labs.${save.state}`)}
          />
          {save.state === "error" ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("labs.reload")}</button> : null}
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
