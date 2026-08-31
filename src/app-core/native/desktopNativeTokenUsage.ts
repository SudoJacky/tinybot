import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { TokenUsageSnapshot } from "../settings/tokenUsage";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type NativeTokenUsageApi = {
  snapshot(): Promise<TokenUsageSnapshot>;
};

export function createDesktopNativeTokenUsageApi(
  options: { invoke?: TauriInvoke } = {},
): NativeTokenUsageApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    snapshot: () => invoke<TokenUsageSnapshot>("worker_token_usage_snapshot"),
  };
}
