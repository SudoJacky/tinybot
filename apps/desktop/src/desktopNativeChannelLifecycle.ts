import type { NativeTransportApi } from "./desktopNativeTransport";

type LifecycleLogger = (event: string, payload?: Record<string, unknown>) => void;

export type DesktopNativeChannelLifecycleOptions = {
  nativeTransport: Pick<NativeTransportApi, "startChannels">;
  logDebug?: LifecycleLogger;
  warn?: (message: string, error: unknown) => void;
};

export async function startDesktopNativeChannelRuntime(
  options: DesktopNativeChannelLifecycleOptions,
): Promise<void> {
  try {
    const result = await options.nativeTransport.startChannels();
    options.logDebug?.("channels.native.start.complete", startResultPayload(result));
  } catch (error) {
    options.logDebug?.("channels.native.start.failed", { error: stringifyError(error) });
    (options.warn ?? console.warn)("Tinybot desktop failed to start native channels", error);
  }
}

function startResultPayload(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.status)) {
    return { status: result.status };
  }
  return { status: result };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
