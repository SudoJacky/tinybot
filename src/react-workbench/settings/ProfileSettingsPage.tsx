import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  DailyModelTokenUsage,
  DailyTokenUsage,
  TokenUsageCounts,
  TokenUsageSnapshot,
} from "../../app-core/settings/tokenUsage";
import type { SettingsStore } from "../services";

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; snapshot: TokenUsageSnapshot }
  | { status: "failed"; error: Error };

type ModelUsageTotal = TokenUsageCounts & {
  providerId: string;
  modelId: string;
};

const EMPTY_USAGE: TokenUsageCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

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
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const formatTokens = (value: number) => new Intl.NumberFormat(locale).format(value);
  const formatCompactTokens = (value: number) => new Intl.NumberFormat(locale, {
    compactDisplay: "short",
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
  const providers = useMemo(
    () => [...new Set(snapshot.modelDays.map((entry) => entry.providerId))].sort(),
    [snapshot.modelDays],
  );
  const modelOptions = useMemo(() => {
    const options = new Map<string, { key: string; providerId: string; modelId: string }>();
    for (const entry of snapshot.modelDays) {
      if (providerFilter && entry.providerId !== providerFilter) continue;
      const key = modelUsageKey(entry.providerId, entry.modelId);
      options.set(key, { key, providerId: entry.providerId, modelId: entry.modelId });
    }
    return [...options.values()].sort((left, right) => (
      left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId)
    ));
  }, [providerFilter, snapshot.modelDays]);
  const selectedModel = modelOptions.find((option) => option.key === modelFilter);
  const filteredModelDays = useMemo(
    () => snapshot.modelDays.filter((entry) => (
      (!providerFilter || entry.providerId === providerFilter)
      && (!selectedModel || (
        entry.providerId === selectedModel.providerId && entry.modelId === selectedModel.modelId
      ))
    )),
    [providerFilter, selectedModel, snapshot.modelDays],
  );
  const filteredDays = useMemo(
    () => (!providerFilter && !selectedModel
      ? snapshot.days
      : aggregateUsageByDay(filteredModelDays)),
    [filteredModelDays, providerFilter, selectedModel, snapshot.days],
  );
  const filteredTotals = useMemo(
    () => (!providerFilter && !selectedModel
      ? snapshot.totals
      : sumUsage(filteredDays)),
    [filteredDays, providerFilter, selectedModel, snapshot.totals],
  );
  const modelTotals = useMemo(
    () => aggregateUsageByModel(filteredModelDays),
    [filteredModelDays],
  );
  const metrics: Array<{ key: keyof TokenUsageCounts; label: string }> = [
    { key: "inputTokens", label: t("profile.inputTokens") },
    { key: "cachedInputTokens", label: t("profile.cachedInputTokens") },
    { key: "outputTokens", label: t("profile.outputTokens") },
    { key: "reasoningOutputTokens", label: t("profile.reasoningOutputTokens") },
  ];

  return (
    <>
      <fieldset className="react-profile-filters">
        <legend>{t("profile.filtersTitle")}</legend>
        <label>
          <span>{t("profile.provider")}</span>
          <select
            aria-label={t("profile.providerFilterLabel")}
            onChange={(event) => {
              setProviderFilter(event.target.value);
              setModelFilter("");
            }}
            value={providerFilter}
          >
            <option value="">{t("profile.allProviders")}</option>
            {providers.map((providerId) => (
              <option key={providerId} value={providerId}>
                {displayDimension(providerId, t("profile.unknown"))}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("profile.model")}</span>
          <select
            aria-label={t("profile.modelFilterLabel")}
            onChange={(event) => setModelFilter(event.target.value)}
            value={modelFilter}
          >
            <option value="">{t("profile.allModels")}</option>
            {modelOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {providerFilter
                  ? displayDimension(option.modelId, t("profile.unknown"))
                  : formatModelLabel(option.providerId, option.modelId, t("profile.unknown"))}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <section className="react-profile-usage-summary" aria-labelledby="profile-usage-summary-title">
        <div className="react-profile-usage-total">
          <span id="profile-usage-summary-title">{t("profile.totalTokens")}</span>
          <strong>{formatTokens(filteredTotals.totalTokens)}</strong>
        </div>
        <dl className="react-profile-usage-metrics">
          {metrics.map((metric) => (
            <div key={metric.key}>
              <dt>{metric.label}</dt>
              <dd>{formatTokens(filteredTotals[metric.key])}</dd>
            </div>
          ))}
        </dl>
      </section>

      {filteredDays.length ? (
        <section className="react-profile-charts" aria-label={t("profile.chartsLabel")}>
          <DailyUsageChart
            days={filteredDays}
            endDate={snapshot.days[0]?.date}
            formatCompactTokens={formatCompactTokens}
            locale={locale}
          />
          <ModelUsageChart
            formatCompactTokens={formatCompactTokens}
            modelTotals={modelTotals}
            unknownLabel={t("profile.unknown")}
          />
        </section>
      ) : null}

      <section className="react-profile-models" aria-labelledby="profile-models-title">
        <header>
          <h3 id="profile-models-title">{t("profile.modelsTitle")}</h3>
        </header>
        {modelTotals.length ? (
          <div className="react-profile-daily__table-wrap">
            <table aria-label={t("profile.modelsTableLabel")}>
              <thead>
                <tr>
                  <th scope="col">{t("profile.provider")}</th>
                  <th scope="col">{t("profile.model")}</th>
                  <th scope="col">{t("profile.inputTokens")}</th>
                  <th scope="col">{t("profile.cachedInputTokens")}</th>
                  <th scope="col">{t("profile.outputTokens")}</th>
                  <th scope="col">{t("profile.reasoningOutputTokens")}</th>
                  <th scope="col">{t("profile.totalTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {modelTotals.map((entry) => (
                  <tr key={modelUsageKey(entry.providerId, entry.modelId)}>
                    <th scope="row">{displayDimension(entry.providerId, t("profile.unknown"))}</th>
                    <td>{displayDimension(entry.modelId, t("profile.unknown"))}</td>
                    <td>{formatTokens(entry.inputTokens)}</td>
                    <td>{formatTokens(entry.cachedInputTokens)}</td>
                    <td>{formatTokens(entry.outputTokens)}</td>
                    <td>{formatTokens(entry.reasoningOutputTokens)}</td>
                    <td>{formatTokens(entry.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="react-profile-daily__empty">{t("profile.noData")}</p>
        )}
      </section>

      <section className="react-profile-daily" aria-labelledby="profile-daily-title">
        <header>
          <h3 id="profile-daily-title">{t("profile.dailyTitle")}</h3>
        </header>
        {filteredDays.length ? (
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
                {filteredDays.map((day) => (
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

function DailyUsageChart({
  days,
  endDate,
  formatCompactTokens,
  locale,
}: {
  days: DailyTokenUsage[];
  endDate?: string;
  formatCompactTokens: (value: number) => string;
  locale: string;
}) {
  const { t } = useTranslation("settings");
  const { figureRef, isRevealed, replay, replayKey } = useChartReveal();
  const series = fillRecentDays(days, endDate, 30);
  const width = 640;
  const height = 250;
  const left = 24;
  const right = 18;
  const top = 30;
  const baseline = 202;
  const maximum = Math.max(1, ...series.map((day) => day.totalTokens));
  const x = (index: number) => left + (index / Math.max(series.length - 1, 1)) * (width - left - right);
  const y = (value: number) => baseline - (value / maximum) * (baseline - top);
  const points = series.map((day, index) => `${x(index)} ${y(day.totalTokens)}`).join(" L ");
  const peakIndex = series.reduce(
    (best, day, index) => day.totalTokens > series[best].totalTokens ? index : best,
    0,
  );
  const peak = series[peakIndex];
  const chartLabel = t("profile.trendChartLabel", {
    date: formatUsageDate(peak.date, locale),
    tokens: formatCompactTokens(peak.totalTokens),
  });
  const seriesKey = series.map((day) => `${day.date}:${day.totalTokens}`).join("|");

  return (
    <figure
      aria-label={t("profile.replayChartLabel", { chart: chartLabel })}
      className="react-profile-chart-card"
      data-reveal-state={isRevealed ? "revealed" : "pending"}
      onClick={replay}
      onKeyDown={(event) => handleChartReplayKeyDown(event, replay)}
      ref={figureRef}
      role="button"
      tabIndex={0}
    >
      <figcaption>
        <h3>{t("profile.trendTitle", { date: formatUsageDate(peak.date, locale) })}</h3>
      </figcaption>
      <svg aria-label={chartLabel} key={`${seriesKey}:${replayKey}`} role="img" viewBox={`0 0 ${width} ${height}`}>
        <title>{chartLabel}</title>
        <desc>{t("profile.trendDescription")}</desc>
        {[0, 0.5, 1].map((ratio, gridIndex) => {
          const gridY = y(maximum * ratio);
          return (
            <g key={ratio}>
              <line
                className="react-profile-chart__fade react-profile-chart__grid"
                style={{ animationDelay: `${gridIndex * 40}ms` }}
                x1={left}
                x2={width - right}
                y1={gridY}
                y2={gridY}
              />
              <text
                className="react-profile-chart__axis react-profile-chart__fade"
                style={{ animationDelay: `${gridIndex * 40}ms` }}
                x={left}
                y={gridY - 6}
              >
                {formatCompactTokens(maximum * ratio)}
              </text>
            </g>
          );
        })}
        {series.map((day, index) => (
          <line
            className="react-profile-chart__calendar-tick react-profile-chart__fade"
            key={`tick-${day.date}`}
            style={{ animationDelay: `${index * 8}ms` }}
            x1={x(index)}
            x2={x(index)}
            y1={baseline}
            y2={baseline + 7}
          />
        ))}
        <path className="react-profile-chart__line" d={`M${points}`} pathLength={1} />
        {series.map((day, index) => {
          const parsedDate = parseUsageDate(day.date);
          const weekend = parsedDate ? parsedDate.getDay() % 6 === 0 : false;
          return (
            <circle
              className="react-profile-chart__dot"
              cx={x(index)}
              cy={y(day.totalTokens)}
              fill={weekend ? "var(--color-panel)" : "var(--color-ink)"}
              key={day.date}
              r={index === peakIndex ? 4.8 : 2.5}
              stroke="var(--color-ink)"
              strokeWidth={weekend ? 1.2 : 0}
              style={{ animationDelay: `${200 + index * 12}ms` }}
            >
              <title>{`${formatUsageDate(day.date, locale)} — ${formatCompactTokens(day.totalTokens)}`}</title>
            </circle>
          );
        })}
        <text
          className="react-profile-chart__fade react-profile-chart__peak"
          style={{ animationDelay: `${800 + peakIndex * 8}ms` }}
          x={x(peakIndex)}
          y={Math.max(15, y(peak.totalTokens) - 12)}
        >
          {formatCompactTokens(peak.totalTokens)}
        </text>
        {[0, Math.floor(series.length / 2), series.length - 1].map((index, labelIndex) => (
          <text
            className="react-profile-chart__date react-profile-chart__fade"
            key={`date-${series[index].date}`}
            style={{ animationDelay: `${120 + labelIndex * 80}ms` }}
            textAnchor={index === 0 ? "start" : index === series.length - 1 ? "end" : "middle"}
            x={x(index)}
            y={baseline + 24}
          >
            {formatShortUsageDate(series[index].date, locale)}
          </text>
        ))}
      </svg>
    </figure>
  );
}

function ModelUsageChart({
  formatCompactTokens,
  modelTotals,
  unknownLabel,
}: {
  formatCompactTokens: (value: number) => string;
  modelTotals: ModelUsageTotal[];
  unknownLabel: string;
}) {
  const { t } = useTranslation("settings");
  const { figureRef, isRevealed, replay, replayKey } = useChartReveal();
  const rows = modelTotals.slice(0, 6);
  if (!rows.length) return null;
  const width = 640;
  const height = 64 + rows.length * 52;
  const labelEnd = 194;
  const railStart = 214;
  const railEnd = 538;
  const maximum = Math.max(1, ...rows.map((row) => row.totalTokens));
  const unit = niceTickUnit(maximum / 22);
  const top = rows[0];
  const topLabel = formatModelLabel(top.providerId, top.modelId, unknownLabel);
  const chartLabel = t("profile.modelChartLabel", {
    model: topLabel,
    tokens: formatCompactTokens(top.totalTokens),
  });
  const rowsKey = rows
    .map((row) => `${modelUsageKey(row.providerId, row.modelId)}:${row.totalTokens}`)
    .join("|");

  return (
    <figure
      aria-label={t("profile.replayChartLabel", { chart: chartLabel })}
      className="react-profile-chart-card"
      data-reveal-state={isRevealed ? "revealed" : "pending"}
      onClick={replay}
      onKeyDown={(event) => handleChartReplayKeyDown(event, replay)}
      ref={figureRef}
      role="button"
      tabIndex={0}
    >
      <figcaption>
        <h3>{t("profile.modelChartTitle", { model: topLabel })}</h3>
      </figcaption>
      <svg aria-label={chartLabel} key={`${rowsKey}:${replayKey}`} role="img" viewBox={`0 0 ${width} ${height}`}>
        <title>{chartLabel}</title>
        <desc>{t("profile.modelChartDescription", { unit: formatCompactTokens(unit) })}</desc>
        {rows.map((row, rowIndex) => {
          const rowY = 38 + rowIndex * 52;
          const ticks = row.totalTokens > 0 ? Math.max(1, Math.round(row.totalTokens / unit)) : 0;
          const rowEnd = railStart + (row.totalTokens / maximum) * (railEnd - railStart);
          const label = formatModelLabel(row.providerId, row.modelId, unknownLabel);
          const stroke = rowIndex === 0
            ? "var(--color-ink)"
            : rowIndex < 3
              ? "var(--color-body)"
              : "var(--color-muted)";
          return (
            <g key={modelUsageKey(row.providerId, row.modelId)}>
              <text
                className="react-profile-chart__fade react-profile-chart__model"
                style={{ animationDelay: `${rowIndex * 100}ms` }}
                textAnchor="end"
                x={labelEnd}
                y={rowY + 3}
              >
                {truncateChartLabel(label)}
                <title>{label}</title>
              </text>
              <line
                className="react-profile-chart__fade react-profile-chart__grid"
                style={{ animationDelay: `${rowIndex * 100}ms` }}
                x1={railStart}
                x2={railEnd}
                y1={rowY + 8}
                y2={rowY + 8}
              />
              {Array.from({ length: ticks }, (_, tickIndex) => {
                const tickX = railStart + ((tickIndex + 0.5) / ticks) * (rowEnd - railStart);
                return (
                  <g key={tickIndex}>
                    <line
                      className="react-profile-chart__model-tick"
                      stroke={stroke}
                      style={{ animationDelay: `${rowIndex * 100 + tickIndex * 12}ms` }}
                      x1={tickX}
                      x2={tickX}
                      y1={rowY - 8 - ((tickIndex + rowIndex) % 3)}
                      y2={rowY + 8}
                    />
                    {tickIndex % 5 === 4 ? (
                      <circle
                        className="react-profile-chart__fade react-profile-chart__marker"
                        cx={tickX}
                        cy={rowY + 13}
                        r={1.2}
                        style={{ animationDelay: `${rowIndex * 100 + tickIndex * 12}ms` }}
                      />
                    ) : null}
                  </g>
                );
              })}
              <text
                className="react-profile-chart__fade react-profile-chart__value"
                style={{ animationDelay: `${400 + rowIndex * 100}ms` }}
                x={railEnd + 14}
                y={rowY + 3}
              >
                {formatCompactTokens(row.totalTokens)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function useChartReveal() {
  const figureRef = useRef<HTMLElement | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setIsRevealed(true);
      observer.disconnect();
    }, { threshold: 0.3 });
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);

  const replay = () => {
    if (isRevealed) setReplayKey((value) => value + 1);
  };

  return { figureRef, isRevealed, replay, replayKey };
}

function handleChartReplayKeyDown(event: ReactKeyboardEvent<HTMLElement>, replay: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  replay();
}

function aggregateUsageByDay(entries: DailyModelTokenUsage[]): DailyTokenUsage[] {
  const days = new Map<string, TokenUsageCounts>();
  for (const entry of entries) {
    const usage = days.get(entry.date) ?? { ...EMPTY_USAGE };
    addUsage(usage, entry);
    days.set(entry.date, usage);
  }
  return [...days.entries()]
    .map(([date, usage]) => ({ date, ...usage }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

function aggregateUsageByModel(entries: DailyModelTokenUsage[]): ModelUsageTotal[] {
  const models = new Map<string, ModelUsageTotal>();
  for (const entry of entries) {
    const key = modelUsageKey(entry.providerId, entry.modelId);
    const usage = models.get(key) ?? {
      ...EMPTY_USAGE,
      providerId: entry.providerId,
      modelId: entry.modelId,
    };
    addUsage(usage, entry);
    models.set(key, usage);
  }
  return [...models.values()].sort((left, right) => (
    right.totalTokens - left.totalTokens
    || left.providerId.localeCompare(right.providerId)
    || left.modelId.localeCompare(right.modelId)
  ));
}

function sumUsage(entries: TokenUsageCounts[]): TokenUsageCounts {
  const totals = { ...EMPTY_USAGE };
  for (const entry of entries) addUsage(totals, entry);
  return totals;
}

function addUsage(target: TokenUsageCounts, source: TokenUsageCounts): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

function fillRecentDays(days: DailyTokenUsage[], endDate: string | undefined, count: number): DailyTokenUsage[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const parsedEnd = parseUsageDate(endDate ?? days[0]?.date) ?? new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(parsedEnd.getFullYear(), parsedEnd.getMonth(), parsedEnd.getDate() - (count - 1 - index));
    const key = formatDateKey(date);
    return byDate.get(key) ?? { date: key, ...EMPTY_USAGE };
  });
}

function niceTickUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function modelUsageKey(providerId: string, modelId: string): string {
  return `${providerId}\u001f${modelId}`;
}

function displayDimension(value: string, unknownLabel: string): string {
  return value === "unknown" ? unknownLabel : value;
}

function formatModelLabel(providerId: string, modelId: string, unknownLabel: string): string {
  return `${displayDimension(providerId, unknownLabel)} / ${displayDimension(modelId, unknownLabel)}`;
}

function truncateChartLabel(value: string): string {
  return value.length > 30 ? `${value.slice(0, 27)}…` : value;
}

function formatUsageDate(date: string, locale: string): string {
  const parsed = parseUsageDate(date);
  if (!parsed) return date;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function formatShortUsageDate(date: string, locale: string): string {
  const parsed = parseUsageDate(date);
  if (!parsed) return date;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(parsed);
}

function parseUsageDate(date: string | undefined): Date | null {
  const [year, month, day] = (date ?? "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
