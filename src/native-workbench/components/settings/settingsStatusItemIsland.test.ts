// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSettingsStatusItemIsland } from "./settingsStatusItemIsland";

describe("settings status item Vue island", () => {
  test("renders settings status label and value", () => {
    const host = document.createElement("p");

    const mounted = mountSettingsStatusItemIsland(host, {
      label: "Save",
      value: "Saved",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-status-item");
    expect(host.className).toBe("desktop-settings-status-item");
    expect(host.querySelector("span")?.textContent).toBe("Save: ");
    expect(host.querySelector("strong")?.textContent).toBe("Saved");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("keeps empty status values visible", () => {
    const host = document.createElement("p");

    mountSettingsStatusItemIsland(host, {
      label: "Models",
      value: "",
    });

    expect(host.querySelector("span")?.textContent).toBe("Models: ");
    expect(host.querySelector("strong")?.textContent).toBe("");
  });
});
