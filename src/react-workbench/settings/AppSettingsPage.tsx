import { useTranslation } from "react-i18next";
import type { AppLanguage } from "../../app-core/settings/appLanguage";
import { useAppLanguage } from "./AppLanguageContext";
import { SettingsSegmentedChoice } from "./SettingsSegmentedChoice";
import { saveComposerRichText } from "../../app-core/settings/composerPreferences";
import { useComposerRichText } from "../../components/ui/useComposerRichText";
import { LiquidToggle } from "../../components/ui/LiquidToggle";

export function AppSettingsPage() {
  const { language, setLanguage } = useAppLanguage();
  const composerRichText = useComposerRichText();
  const { t } = useTranslation("settings");
  return (
    <section className="react-app-settings" aria-labelledby="app-settings-title">
      <header className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("app.eyebrow")}</span>
          <h2 id="app-settings-title">{t("app.title")}</h2>
          <p>{t("app.description")}</p>
        </div>
      </header>

      <div className="react-app-settings__list">
        <SettingsSegmentedChoice
          description={t("app.language.description")}
          label={t("app.language.label")}
          options={[
            {
              value: "en",
              label: t("app.language.english"),
            },
            {
              value: "zh",
              label: t("app.language.chinese"),
            },
          ]}
          value={language}
          onChange={(value) => setLanguage(value as AppLanguage)}
        />
        <label className="react-appearance-row react-appearance-row--toggle">
          <span>
            <strong>{t("app.composerRichText.label")}</strong>
            <small>{t("app.composerRichText.description")}</small>
          </span>
          <LiquidToggle
            aria-label={t("app.composerRichText.label")}
            checked={composerRichText}
            onChange={(event) => saveComposerRichText(event.currentTarget.checked)}
          />
        </label>
      </div>
      <small className="react-app-settings__persistence">{t("app.persistence")}</small>
    </section>
  );
}
