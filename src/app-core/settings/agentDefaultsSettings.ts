export type AgentDefaultsFormValues = {
  timezone: string;
  temperature: string;
  maxTokens: string;
  contextWindowTokens: string;
  contextWindowStrategy: string;
  maxToolIterations: string;
  reasoningEffort: string;
};

export type AgentDefaultsSettingsData = {
  currentConfig: unknown;
  revision?: string;
  activeProfileId: string | null;
  defaultModel: string | null;
  values: AgentDefaultsFormValues;
};

export type AgentDefaultsValidationErrors = Partial<Record<keyof AgentDefaultsFormValues, string>>;

type JsonRecord = Record<string, unknown>;

const DEFAULT_AGENT_MAX_TOKENS = 8192;
const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_AGENT_CONTEXT_WINDOW_STRATEGY = "discard";
const DEFAULT_AGENT_MAX_TOOL_ITERATIONS = 200;
const DEFAULT_AGENT_REASONING_EFFORT = "medium";

export function buildAgentDefaultsSettings(config: unknown): AgentDefaultsSettingsData {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  return {
    currentConfig: config,
    revision: stringOrUndefined(root.revision) ?? stringOrUndefined(asRecord(root.configMetadata).revision),
    activeProfileId: stringOrNull(pick(defaults, "activeProfile", "active_profile")),
    defaultModel: stringOrNull(defaults.model),
    values: {
      timezone: stringValue(defaults.timezone),
      temperature: formNumber(pick(defaults, "temperature")),
      maxTokens: formNumber(pick(defaults, "maxTokens", "max_tokens"), DEFAULT_AGENT_MAX_TOKENS),
      contextWindowTokens: formNumber(
        pick(defaults, "contextWindowTokens", "context_window_tokens"),
        DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
      ),
      contextWindowStrategy: contextWindowStrategyValue(
        pick(defaults, "contextWindowStrategy", "context_window_strategy"),
      ) || DEFAULT_AGENT_CONTEXT_WINDOW_STRATEGY,
      maxToolIterations: formNumber(
        pick(defaults, "maxIterations", "max_iterations", "maxToolIterations", "max_tool_iterations"),
        DEFAULT_AGENT_MAX_TOOL_ITERATIONS,
      ),
      reasoningEffort: stringValue(pick(defaults, "reasoningEffort", "reasoning_effort")) || DEFAULT_AGENT_REASONING_EFFORT,
    },
  };
}

export function validateAgentDefaultsInput(values: AgentDefaultsFormValues): AgentDefaultsValidationErrors {
  const errors: AgentDefaultsValidationErrors = {};
  const temperature = parseOptionalNumber(values.temperature);
  if (temperature !== null && !Number.isFinite(temperature)) {
    errors.temperature = "Temperature must be a number between 0 and 2.";
  }
  if (temperature !== null && (temperature < 0 || temperature > 2)) {
    errors.temperature = "Temperature must be between 0 and 2.";
  }
  if (!isOptionalPositiveInteger(values.maxTokens)) {
    errors.maxTokens = "Max output tokens must be a positive integer.";
  }
  if (!isOptionalPositiveInteger(values.contextWindowTokens)) {
    errors.contextWindowTokens = "Context window budget must be a positive integer.";
  }
  if (!isContextWindowStrategy(values.contextWindowStrategy)) {
    errors.contextWindowStrategy = "Context window strategy must be discard or compact.";
  }
  if (!isOptionalPositiveInteger(values.maxToolIterations)) {
    errors.maxToolIterations = "Max tool iterations must be a positive integer.";
  }
  return errors;
}

export function buildAgentDefaultsPatch(values: AgentDefaultsFormValues): JsonRecord {
  const defaults: JsonRecord = {};
  const timezone = values.timezone.trim();
  if (timezone) {
    defaults.timezone = timezone;
  }
  const temperature = parseOptionalNumber(values.temperature);
  if (temperature !== null && Number.isFinite(temperature)) {
    defaults.temperature = temperature;
  }
  setOptionalInteger(defaults, "maxTokens", values.maxTokens);
  setOptionalInteger(defaults, "contextWindowTokens", values.contextWindowTokens);
  const contextWindowStrategy = contextWindowStrategyValue(values.contextWindowStrategy);
  if (contextWindowStrategy) {
    defaults.contextWindowStrategy = contextWindowStrategy;
  }
  setOptionalInteger(defaults, "maxIterations", values.maxToolIterations);
  const reasoningEffort = values.reasoningEffort.trim();
  if (reasoningEffort) {
    defaults.reasoningEffort = reasoningEffort;
  }
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

function parseOptionalNumber(value: string): number | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : Number.NaN;
}

function formNumber(value: unknown, fallback?: number): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback === undefined ? "" : String(fallback);
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return stringOrNull(value) ?? undefined;
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
