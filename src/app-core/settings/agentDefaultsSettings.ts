import { validateDesktopTimezone } from "./desktopSettingsProviders";

export type AgentDefaultsFormValues = {
  timezone: string;
  maxTokens: string;
  contextWindowStrategy: string;
  maxToolIterations: string;
};

export type AgentDefaultsSettingsData = {
  currentConfig: unknown;
  revision?: string;
  fallbackContextWindowTokens: number;
  values: AgentDefaultsFormValues;
};

export type AgentDefaultsValidationErrorCode =
  | "context-strategy"
  | "max-tokens"
  | "max-tool-iterations"
  | "timezone";

export type AgentDefaultsValidationErrors = Partial<Record<keyof AgentDefaultsFormValues, AgentDefaultsValidationErrorCode>>;

type JsonRecord = Record<string, unknown>;

const DEFAULT_AGENT_MAX_TOKENS = 8192;
const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_AGENT_CONTEXT_WINDOW_STRATEGY = "compact";
const DEFAULT_AGENT_MAX_TOOL_ITERATIONS = 200;

export function buildAgentDefaultsSettings(
  config: unknown,
  systemTimeZone = resolveSystemTimeZone(),
): AgentDefaultsSettingsData {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  return {
    currentConfig: config,
    revision: stringOrUndefined(root.revision) ?? stringOrUndefined(asRecord(root.configMetadata).revision),
    fallbackContextWindowTokens: positiveInteger(
      pick(defaults, "contextWindowTokens", "context_window_tokens"),
      DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
    ),
    values: {
      timezone: stringValue(defaults.timezone).trim() || normalizedTimeZone(systemTimeZone),
      maxTokens: formNumber(pick(defaults, "maxTokens", "max_tokens"), DEFAULT_AGENT_MAX_TOKENS),
      contextWindowStrategy: contextWindowStrategyValue(
        pick(defaults, "contextWindowStrategy", "context_window_strategy"),
      ) || DEFAULT_AGENT_CONTEXT_WINDOW_STRATEGY,
      maxToolIterations: formNumber(
        pick(defaults, "maxIterations", "max_iterations", "maxToolIterations", "max_tool_iterations"),
        DEFAULT_AGENT_MAX_TOOL_ITERATIONS,
      ),
    },
  };
}

export function validateAgentDefaultsInput(values: AgentDefaultsFormValues): AgentDefaultsValidationErrors {
  const errors: AgentDefaultsValidationErrors = {};
  if (!validateDesktopTimezone(values.timezone)) {
    errors.timezone = "timezone";
  }
  if (!isOptionalPositiveInteger(values.maxTokens)) {
    errors.maxTokens = "max-tokens";
  }
  if (!isContextWindowStrategy(values.contextWindowStrategy)) {
    errors.contextWindowStrategy = "context-strategy";
  }
  if (!isOptionalPositiveInteger(values.maxToolIterations)) {
    errors.maxToolIterations = "max-tool-iterations";
  }
  return errors;
}

export function resolveSystemTimeZone(): string {
  try {
    return normalizedTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

export function listSupportedTimeZones(
  configuredTimeZone = "",
  systemTimeZone = resolveSystemTimeZone(),
): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supported = readSupportedTimeZones(intl);
  return Array.from(new Set([
    configuredTimeZone.trim(),
    normalizedTimeZone(systemTimeZone),
    "UTC",
    ...supported,
  ].filter((timeZone) => validateDesktopTimezone(timeZone))));
}

function readSupportedTimeZones(intl: typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
}): string[] {
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function buildAgentDefaultsPatch(values: AgentDefaultsFormValues): JsonRecord {
  const defaults: JsonRecord = {};
  const timezone = values.timezone.trim();
  if (timezone) {
    defaults.timezone = timezone;
  }
  setOptionalInteger(defaults, "maxTokens", values.maxTokens);
  const contextWindowStrategy = contextWindowStrategyValue(values.contextWindowStrategy);
  if (contextWindowStrategy) {
    defaults.contextWindowStrategy = contextWindowStrategy;
  }
  setOptionalInteger(defaults, "maxIterations", values.maxToolIterations);
  return { agents: { defaults } };
}

function setOptionalInteger(record: JsonRecord, key: string, value: string): void {
  const text = value.trim();
  if (text) {
    record[key] = Number.parseInt(text, 10);
  }
}

function isOptionalPositiveInteger(value: string): boolean {
  const text = value.trim();
  return !text || (/^\d+$/.test(text) && Number.parseInt(text, 10) > 0);
}

function isContextWindowStrategy(value: string): boolean {
  return Boolean(contextWindowStrategyValue(value));
}

function contextWindowStrategyValue(value: unknown): string {
  const text = stringValue(value).trim().toLowerCase();
  return text === "discard" || text === "compact" ? text : "";
}

function formNumber(value: unknown, fallback?: number): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback === undefined ? "" : String(fallback);
}

function normalizedTimeZone(value: unknown): string {
  const timeZone = stringValue(value).trim();
  return validateDesktopTimezone(timeZone) ? timeZone : "UTC";
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}
