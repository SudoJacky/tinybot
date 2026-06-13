import { describe, expect, test, vi } from "vitest";

import { startDesktopNativeChannelRuntime } from "./desktopNativeChannelLifecycle";
import type { NativeTransportApi } from "./desktopNativeTransport";

describe("desktop native channel lifecycle", () => {
  test("starts TS-managed native channels during desktop bootstrap", async () => {
    const nativeTransport = nativeTransportStub({
      startChannels: vi.fn(async () => ({
        started: true,
        status: { running: true, channels: [], diagnostics: [] },
      })),
    });
    const logDebug = vi.fn();

    await expect(startDesktopNativeChannelRuntime({ nativeTransport, logDebug })).resolves.toBeUndefined();

    expect(nativeTransport.startChannels).toHaveBeenCalledTimes(1);
    expect(logDebug).toHaveBeenCalledWith("channels.native.start.complete", {
      status: { running: true, channels: [], diagnostics: [] },
    });
  });

  test("logs native channel startup failures without blocking bootstrap", async () => {
    const nativeTransport = nativeTransportStub({
      startChannels: vi.fn(async () => {
        throw new Error("worker unavailable");
      }),
    });
    const logDebug = vi.fn();
    const warn = vi.fn();

    await expect(startDesktopNativeChannelRuntime({ nativeTransport, logDebug, warn })).resolves.toBeUndefined();

    expect(nativeTransport.startChannels).toHaveBeenCalledTimes(1);
    expect(logDebug).toHaveBeenCalledWith("channels.native.start.failed", {
      error: "worker unavailable",
    });
    expect(warn).toHaveBeenCalledWith("Tinybot desktop failed to start native channels", expect.any(Error));
  });
});

function nativeTransportStub(overrides: Partial<NativeTransportApi>): NativeTransportApi {
  return {
    gatewayFrame: vi.fn(),
    websocketMessage: vi.fn(),
    dispatchWebsocketMessage: vi.fn(),
    dispatchChannelInbound: vi.fn(),
    startChannels: vi.fn(),
    channelStatus: vi.fn(),
    stopChannels: vi.fn(),
    ...overrides,
  };
}
