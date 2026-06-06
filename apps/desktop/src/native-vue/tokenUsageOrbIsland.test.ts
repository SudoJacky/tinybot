// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountTokenUsageOrbIsland } from "./tokenUsageOrbIsland";

describe("token usage orb Vue island", () => {
  test("renders token usage as a desktop meter orb", () => {
    const host = document.createElement("span");

    const mounted = mountTokenUsageOrbIsland(host, {
      tokenUsage: "42% of context",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("token-usage-orb");
    expect(host.className).toContain("desktop-native-token-orb");
    expect(host.getAttribute("role")).toBe("meter");
    expect(host.getAttribute("aria-label")).toBe("Token usage 42%");
    expect(host.getAttribute("aria-valuemin")).toBe("0");
    expect(host.getAttribute("aria-valuemax")).toBe("100");
    expect(host.getAttribute("aria-valuenow")).toBe("42");
    expect(host.getAttribute("data-token-usage")).toBe("42");
    expect(host.style.getPropertyValue("--token-usage-fill")).toBe("42%");
    expect(host.querySelector(".n-progress.desktop-native-token-progress")).not.toBeNull();
    expect(host.textContent).toContain("42%");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("clamps invalid or out of range token usage", () => {
    const highHost = document.createElement("span");
    const invalidHost = document.createElement("span");

    const high = mountTokenUsageOrbIsland(highHost, { tokenUsage: "142%" });
    const invalid = mountTokenUsageOrbIsland(invalidHost, { tokenUsage: "-" });

    expect(highHost.getAttribute("data-token-usage")).toBe("100");
    expect(invalidHost.getAttribute("data-token-usage")).toBe("0");

    high.unmount();
    invalid.unmount();
  });
});
