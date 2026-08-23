import { describe, expect, it, vi } from "vitest";
import { presentMainWindowForQuickChat } from "./desktopNativePetQuickChat";

describe("presentMainWindowForQuickChat", () => {
  it("restores a minimized main window before focusing it", async () => {
    const calls: string[] = [];
    const mainWindow = {
      show: vi.fn(async () => { calls.push("show"); }),
      unminimize: vi.fn(async () => { calls.push("unminimize"); }),
      setFocus: vi.fn(async () => { calls.push("setFocus"); }),
    };

    await presentMainWindowForQuickChat(mainWindow);

    expect(calls).toEqual(["show", "unminimize", "setFocus"]);
  });
});
