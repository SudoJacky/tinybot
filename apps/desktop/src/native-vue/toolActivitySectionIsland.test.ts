// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountToolActivitySectionIsland } from "./toolActivitySectionIsland";

describe("tool activity section Vue island", () => {
  test("renders call section label and preformatted text", () => {
    const host = document.createElement("div");

    const mounted = mountToolActivitySectionIsland(host, {
      kind: "call",
      label: "Arguments",
      text: "{\"query\":\"tinybot\"}",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tool-activity-section");
    expect(host.className).toBe("desktop-tool-activity-section desktop-tool-activity-section-call");
    expect(host.querySelector(".desktop-tool-activity-label")?.textContent).toBe("Arguments");
    expect(host.querySelector(".desktop-tool-activity-pre")?.textContent).toBe("{\"query\":\"tinybot\"}");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders response section class", () => {
    const host = document.createElement("div");

    mountToolActivitySectionIsland(host, {
      kind: "response",
      label: "Response",
      text: "Done",
    });

    expect(host.className).toBe("desktop-tool-activity-section desktop-tool-activity-section-response");
    expect(host.textContent).toBe("ResponseDone");
  });
});
