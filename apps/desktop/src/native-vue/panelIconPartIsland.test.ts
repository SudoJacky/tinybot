// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountPanelIconPartIsland } from "./panelIconPartIsland";

describe("panel icon part Vue island", () => {
  test("renders frame icon part class", () => {
    const host = document.createElement("span");

    const mounted = mountPanelIconPartIsland(host, {
      part: "frame",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("panel-icon-part");
    expect(host.className).toBe("desktop-chat-header-panel-icon-frame");
    expect(host.textContent).toBe("");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders rail icon part class", () => {
    const host = document.createElement("span");

    mountPanelIconPartIsland(host, {
      part: "rail",
    });

    expect(host.className).toBe("desktop-chat-header-panel-icon-rail");
  });
});
