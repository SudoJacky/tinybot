import type { TinybotConfig } from "./configTypes.ts";
import { defaultTinybotConfig, parseTinybotConfig, TinybotConfigValidationError } from "./configSchema.ts";

export type ConfigLoadDiagnostic = {
  level: "info" | "warning";
  code: "missing_config" | "invalid_json" | "invalid_config";
  message: string;
  path?: string;
};

export type ConfigLoadResult = {
  source: "default" | "file";
  config: TinybotConfig;
  diagnostics: ConfigLoadDiagnostic[];
};

export function loadTinybotConfigFromJsonText(
  text: string | null | undefined,
  options: { path?: string } = {},
): ConfigLoadResult {
  if (text === null || text === undefined || text.trim() === "") {
    return defaultResult({
      level: "info",
      code: "missing_config",
      message: "config file is missing; using defaults",
      path: options.path,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return defaultResult({
      level: "warning",
      code: "invalid_json",
      message: `failed to parse config JSON: ${errorMessage(error)}`,
      path: options.path,
    });
  }

  if (!isRecord(raw)) {
    return defaultResult({
      level: "warning",
      code: "invalid_config",
      message: "config root must be an object",
      path: options.path,
    });
  }

  try {
    return {
      source: "file",
      config: parseTinybotConfig(raw),
      diagnostics: [],
    };
  } catch (error) {
    return defaultResult({
      level: "warning",
      code: "invalid_config",
      message: error instanceof TinybotConfigValidationError ? error.message : `failed to validate config: ${errorMessage(error)}`,
      path: options.path,
    });
  }
}

export function serializeTinybotConfig(config: TinybotConfig): string {
  return JSON.stringify(config, null, 2);
}

function defaultResult(diagnostic: ConfigLoadDiagnostic): ConfigLoadResult {
  return {
    source: "default",
    config: defaultTinybotConfig(),
    diagnostics: [diagnostic],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
