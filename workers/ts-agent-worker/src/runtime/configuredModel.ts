import { DEFAULT_AGENT_MODEL } from "../config/defaults.ts";
import { providerRuntimeFromNativeConfig, type NativeConfigBridge } from "./configBridge.ts";

export async function configuredDefaultModel(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
): Promise<string> {
  try {
    const runtime = await providerRuntimeFromNativeConfig(configBridge, env, {});
    const model = stringValue(runtime.model);
    return model ?? DEFAULT_AGENT_MODEL;
  } catch {
    return DEFAULT_AGENT_MODEL;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
