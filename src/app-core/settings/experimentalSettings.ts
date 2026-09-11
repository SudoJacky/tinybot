export type ExperimentalSettings = {
  actionFusion: boolean;
};

export function readExperimentalSettings(config: unknown): ExperimentalSettings {
  if (!isRecord(config)) throw new Error("Invalid configuration snapshot");
  if (config.experiments === undefined) return { actionFusion: false };
  if (!isRecord(config.experiments)) throw new Error("experiments must be an object");
  const value = config.experiments.actionFusion;
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("experiments.actionFusion must be a boolean");
  }
  return { actionFusion: value ?? false };
}

export function actionFusionSettingsPatch(enabled: boolean) {
  return { experiments: { actionFusion: enabled } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
