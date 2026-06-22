import { describe, expect, test } from "vitest";
import { toDesktopNativeTauriEventName } from "./desktopNativeTauriEvents";

describe("desktop native Tauri events", () => {
  test("maps worker protocol event names to Tauri-safe names", () => {
    expect(toDesktopNativeTauriEventName("agent.delta")).toBe("agent:delta");
    expect(toDesktopNativeTauriEventName("agent.tool_call.delta")).toBe("agent:tool_call:delta");
    expect(toDesktopNativeTauriEventName("diagnostics.log")).toBe("diagnostics:log");
    expect(toDesktopNativeTauriEventName("worker.status")).toBe("worker:status");
  });
});
