import type { DesktopSecretField } from "./desktopSettingsContracts";

export const DESKTOP_SETTINGS_SECRET_MASK = "********";

export function buildDesktopSecretField(value: unknown, mask = DESKTOP_SETTINGS_SECRET_MASK): DesktopSecretField {
  const raw = stringValue(value);
  return {
    value: raw,
    displayValue: raw ? mask : "",
    masked: Boolean(raw),
    empty: !raw,
  };
}

export function resolveDesktopSecretValue(displayValue: string, previousValue: string, mask = DESKTOP_SETTINGS_SECRET_MASK): string {
  return displayValue === mask ? previousValue : displayValue;
}

export function parseDesktopProviderModelList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
