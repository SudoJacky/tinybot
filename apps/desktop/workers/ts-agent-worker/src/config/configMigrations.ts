import type { JsonRecord } from "./configTypes.ts";

export function applyConfigMigrations(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  const migrated = cloneJsonRecord(raw);
  migrateExecRestrictToWorkspace(migrated);
  return migrated;
}

function migrateExecRestrictToWorkspace(config: JsonRecord): void {
  const tools = isRecord(config.tools) ? config.tools : undefined;
  const exec = isRecord(tools?.exec) ? tools.exec : undefined;
  if (!tools || !exec || exec.restrictToWorkspace === undefined || tools.restrictToWorkspace !== undefined) {
    return;
  }
  tools.restrictToWorkspace = exec.restrictToWorkspace;
  delete exec.restrictToWorkspace;
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return structuredClone(value) as JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
