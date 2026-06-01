import { describe, expect, test } from "vitest";
import {
  DESKTOP_WORKBENCH_STORAGE_KEY,
  resolveDesktopWorkbenchStartupMode,
  resolveDesktopWorkbenchMode,
} from "./desktopWorkbenchGate";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem: (key: string) => (key === DESKTOP_WORKBENCH_STORAGE_KEY ? value : null),
  };
}

describe("desktop workbench gate", () => {
  test("defaults to the recoverable root WebUI mode", () => {
    expect(
      resolveDesktopWorkbenchMode({
        location: { search: "" },
        storage: storageWith(null),
      }),
    ).toEqual({
      mode: "root-webui",
      requestedMode: "root-webui",
      source: "default",
    });
  });

  test("allows native workbench mode when the gated entrypoint is available", () => {
    expect(
      resolveDesktopWorkbenchMode({
        location: { search: "?desktop-workbench=1" },
        storage: storageWith(null),
        nativeWorkbenchAvailable: true,
      }),
    ).toEqual({
      mode: "native-workbench",
      requestedMode: "native-workbench",
      source: "query",
    });
  });

  test("falls back to root WebUI when native workbench is requested before it exists", () => {
    const result = resolveDesktopWorkbenchMode({
      location: { search: "?desktop-workbench=native" },
      storage: storageWith(null),
    });

    expect(result.mode).toBe("root-webui");
    expect(result.requestedMode).toBe("native-workbench");
    expect(result.source).toBe("query");
    expect(result.fallbackReason).toContain("native workbench entrypoint");
  });

  test("lets an explicit root query override a stored native preference", () => {
    expect(
      resolveDesktopWorkbenchMode({
        location: { search: "?desktop-workbench=root" },
        storage: storageWith("native"),
        nativeWorkbenchAvailable: true,
      }),
    ).toEqual({
      mode: "root-webui",
      requestedMode: "root-webui",
      source: "query",
    });
  });

  test("uses stored native preference when no query override exists", () => {
    expect(
      resolveDesktopWorkbenchMode({
        location: { search: "" },
        storage: storageWith("workbench"),
        nativeWorkbenchAvailable: true,
      }),
    ).toEqual({
      mode: "native-workbench",
      requestedMode: "native-workbench",
      source: "storage",
    });
  });

  test("uses root WebUI as the desktop startup default while preserving an explicit native escape hatch", () => {
    expect(
      resolveDesktopWorkbenchStartupMode({
        location: { search: "" },
        storage: storageWith(null),
      }),
    ).toEqual({
      mode: "root-webui",
      requestedMode: "root-webui",
      source: "default",
    });

    expect(
      resolveDesktopWorkbenchStartupMode({
        location: { search: "?desktop-workbench=native" },
        storage: storageWith(null),
      }),
    ).toEqual({
      mode: "native-workbench",
      requestedMode: "native-workbench",
      source: "query",
    });
  });
});
