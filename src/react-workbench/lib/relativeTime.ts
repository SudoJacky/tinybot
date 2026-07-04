export type RelativeTimeInput = number | string | Date | null | undefined;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

export function formatRelativeUpdatedTime(value: RelativeTimeInput, nowMs = Date.now()): string {
  const timestamp = timestampMs(value);
  if (timestamp === null) {
    return "No date";
  }
  const ageMs = Math.max(0, nowMs - timestamp);
  if (ageMs < HOUR_MS) {
    return `${Math.max(1, Math.floor(ageMs / MINUTE_MS))} min`;
  }
  if (ageMs < DAY_MS) {
    return `${Math.floor(ageMs / HOUR_MS)} hr`;
  }
  if (ageMs < WEEK_MS) {
    return `${Math.floor(ageMs / DAY_MS)} days`;
  }
  if (ageMs < MONTH_MS) {
    return `${Math.floor(ageMs / WEEK_MS)} wk`;
  }
  return `${Math.floor(ageMs / MONTH_MS)} mo`;
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
