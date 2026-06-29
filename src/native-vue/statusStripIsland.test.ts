// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountStatusStripIsland } from "./statusStripIsland";

describe("status strip Vue island", () => {
  test("renders the desktop route status host for runtime status updates", () => {
    const host = document.createElement("div");

    const mounted = mountStatusStripIsland(host, {
      message: "No workspace file selected - Gateway http://127.0.0.1:18790",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("status-strip");
    expect(host.className).toContain("desktop-status-strip");
    expect(host.getAttribute("data-desktop-route-status")).toBe("");
    expect(host.textContent).toContain("No workspace file selected");
    expect(host.textContent).toContain("http://127.0.0.1:18790");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
