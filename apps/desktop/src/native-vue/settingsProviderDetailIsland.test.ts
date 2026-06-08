// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSettingsProviderDetailIsland } from "./settingsProviderDetailIsland";

describe("settings provider detail Vue island", () => {
  test("renders provider detail label and value", () => {
    const host = document.createElement("p");

    const mounted = mountSettingsProviderDetailIsland(host, {
      label: "Base URL",
      value: "http://localhost:11434",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-provider-detail");
    expect(host.className).toBe("desktop-settings-provider-detail");
    expect(host.querySelector("span")?.textContent).toBe("Base URL: ");
    expect(host.querySelector("input")?.value).toBe("http://localhost:11434");
    expect(host.textContent).toContain("Base URL: http://localhost:11434");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty values without dropping the label", () => {
    const host = document.createElement("p");

    mountSettingsProviderDetailIsland(host, {
      label: "API Key",
      value: "",
    });

    expect(host.querySelector("span")?.textContent).toBe("API Key: ");
    expect(host.querySelector("input")?.value).toBe("");
  });
});
