import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { loadAppLanguage } from "../../app-core/settings/appLanguage";
import { en } from "./resources/en";
import { zh } from "./resources/zh";

void i18n
  .use(initReactI18next)
  .init({
    defaultNS: "common",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    lng: typeof window === "undefined" ? "en" : loadAppLanguage(),
    ns: ["common", "settings", "memory", "updates", "chat"],
    react: { useSuspense: false },
    resources: { en, zh },
    supportedLngs: ["en", "zh"],
  });

export { i18n };
