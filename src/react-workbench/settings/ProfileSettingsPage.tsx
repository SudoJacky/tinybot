import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TokenUsageCounts, TokenUsageSnapshot } from "../../app-core/settings/tokenUsage";
import type { SettingsStore } from "../services";

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; snapshot: TokenUsageSnapshot }
  | { status: "failed"; error: Error };

export function ProfileSettingsPage({ settingsStore }: { settingsStore: SettingsStore }) {
  const { i18n, t } = useTranslation("settings");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ProfileState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const loadTokenUsage = settingsStore.loadTokenUsage;
    if (!loadTokenUsage) {
      setState({ status: "failed", error: new Error(t("profile.unavailable")) });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "loading" });
    void loadTokenUsage()
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-profile-token-usage]", { attempt: attempt + 1, error });
        setState({ status: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, settingsStore, t]);

  return (
    <section className="react-profile-settings" aria-labelledby="profile-settings-title">
      <header className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("profile.eyebrow")}</span>
          <h2 id="profile-settings-title">{t("profile.title")}</h2>
          <p>{t("profile.description")}</p>
        </div>
      </header>

      {state.status === "loading" ? (
        <p aria-live="polite" className="react-profile-settings__status" role="status">
          {t("profile.loading")}
        </p>
      ) : state.status === "failed" ? (
        <div className="react-profile-settings__status react-profile-settings__status--failed" role="alert">
          <p>{t("profile.loadFailed", { message: state.error.message })}</p>
          <button data-press-feedback="true" onClick={() => setAttempt((value) => value + 1)} type="button">
            <RefreshCw aria-hidden="true" size={14} />
            {t("profile.retry")}
          </button>
        </div>
      ) : (
        <TokenUsageContent
          locale={i18n.resolvedLanguage ?? i18n.language}
          snapshot={state.snapshot}
        />
      )}
    </section>
  );
}

function TokenUsageContent({ locale, snapshot }: { locale: string; snapshot: TokenUsageSnapshot }) {
  const { t } = useTranslation("settings");
  const formatTokens = (value: number) => new Intl.NumberFormat(locale).format(value);
  const metrics: Array<{ key: keyof TokenUsageCounts; label: string }> = [
    { key: "inputTokens", label: t("profile.inputTokens") },
    { key: "cachedInputTokens", label: t("profile.cachedInputTokens") },
    { key: "outputTokens", label: t("profile.outputTokens") },
    { key: "reasoningOutputTokens", label: t("profile.reasoningOutputTokens") },
  ];
  return (
    <>
      <section className="react-profile-usage-summary" aria-labelledby="profile-usage-summary-title">
        <div className="react-profile-usage-total">
          <span id="profile-usage-summary-title">{t("profile.totalTokens")}</span>
          <strong>{formatTokens(snapshot.totals.totalTokens)}</strong>
          <small>{t("profile.totalDescription")}</small>
        </div>
        <dl className="react-profile-usage-metrics">
          {metrics.map((metric) => (
            <div key={metric.key}>
              <dt>{metric.label}</dt>
              <dd>{formatTokens(snapshot.totals[metric.key])}</dd>
            </div>
          ))}
        </dl>
        <p className="react-profile-usage-note">{t("profile.breakdownNote")}</p>
      </section>

      <section className="react-profile-daily" aria-labelledby="profile-daily-title">
        <header>
          <div>
            <h3 id="profile-daily-title">{t("profile.dailyTitle")}</h3>
            <p>{t("profile.dailyDescription")}</p>
          </div>
        </header>
        {snapshot.days.length ? (
          <div className="react-profile-daily__table-wrap">
            <table aria-label={t("profile.dailyTableLabel")}>
              <thead>
                <tr>
                  <th scope="col">{t("profile.date")}</th>
                  <th scope="col">{t("profile.inputTokens")}</th>
                  <th scope="col">{t("profile.cachedInputTokens")}</th>
                  <th scope="col">{t("profile.outputTokens")}</th>
                  <th scope="col">{t("profile.reasoningOutputTokens")}</th>
                  <th scope="col">{t("profile.totalTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{formatUsageDate(day.date, locale)}</th>
                    <td>{formatTokens(day.inputTokens)}</td>
                    <td>{formatTokens(day.cachedInputTokens)}</td>
                    <td>{formatTokens(day.outputTokens)}</td>
                    <td>{formatTokens(day.reasoningOutputTokens)}</td>
                    <td>{formatTokens(day.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="react-profile-daily__empty">{t("profile.noData")}</p>
        )}
      </section>
    </>
  );
}

function formatUsageDate(date: string, locale: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}
