import { DEFAULT_AGENT_MODEL } from "../config/defaults.ts";

export type RuntimeModel = string | (() => string | Promise<string>);

export async function resolveRuntimeModel(model: RuntimeModel | undefined): Promise<string> {
  const value = typeof model === "function" ? await model() : model;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_AGENT_MODEL;
}
