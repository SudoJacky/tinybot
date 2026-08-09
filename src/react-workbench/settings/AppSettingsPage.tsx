import { useTranslation } from "react-i18next";
import type { AppLanguage } from "../../app-core/settings/appLanguage";
import { useAppLanguage } from "./AppLanguageContext";
import { SettingsChoiceList } from "./SettingsChoiceList";

export function AppSettingsPage() {
  const { language, setLanguage } = useAppLanguage();
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
        <SettingsChoiceList
          description={t("app.language.description")}
          label={t("app.language.label")}
          options={[
            {
              value: "en",
              label: t("app.language.english"),
              description: t("app.language.englishDescription"),
            },
            {
              value: "zh",
              label: t("app.language.chinese"),
              description: t("app.language.chineseDescription"),
            },
          ]}
          optionsAriaLabel={t("app.language.optionsLabel")}
          value={language}
          onChange={(value) => setLanguage(value as AppLanguage)}
        />
      </div>
      <small className="react-app-settings__persistence">{t("app.persistence")}</small>
    </section>
  );
}
