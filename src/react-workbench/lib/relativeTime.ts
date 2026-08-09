export type RelativeTimeInput = number | string | Date | null | undefined;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

export function formatRelativeUpdatedTime(
  value: RelativeTimeInput,
  nowMs = Date.now(),
  locale?: string,
  noDate = "No date",
): string {
  const timestamp = timestampMs(value);
  if (timestamp === null) {
    return noDate;
  }
  const ageMs = Math.max(0, nowMs - timestamp);
  if (ageMs < HOUR_MS) {
    return relativeTime(Math.max(1, Math.floor(ageMs / MINUTE_MS)), "minute", locale, "min");
  }
  if (ageMs < DAY_MS) {
    return relativeTime(Math.floor(ageMs / HOUR_MS), "hour", locale, "hr");
  }
  if (ageMs < WEEK_MS) {
    return relativeTime(Math.floor(ageMs / DAY_MS), "day", locale, "days");
  }
  if (ageMs < MONTH_MS) {
    return relativeTime(Math.floor(ageMs / WEEK_MS), "week", locale, "wk");
  }
  return relativeTime(Math.floor(ageMs / MONTH_MS), "month", locale, "mo");
}

function relativeTime(count: number, unit: Intl.RelativeTimeFormatUnit, locale: string | undefined, fallbackUnit: string): string {
  return locale
    ? new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" }).format(-count, unit)
    : `${count} ${fallbackUnit}`;
}

function timestampMs(value: RelativeTimeInput): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  if (value.startsWith("unix-ms:")) {
    const parsed = Number(value.slice("unix-ms:".length));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
