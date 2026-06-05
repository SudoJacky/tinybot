// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountInspectorViewIsland } from "./inspectorViewIsland";

describe("inspector view Vue island", () => {
  test("renders title, subtitle, and inspector rows", () => {
    const host = document.createElement("section");

    const mounted = mountInspectorViewIsland(host, {
      emptyText: "Nothing selected",
      rows: [
        "Status: completed",
        "Browser action: Open docs | https://example.test/docs",
      ],
      subtitle: "Run detail",
      title: "Inspector",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("inspector-view");
    expect(host.className).toBe("desktop-workbench-section desktop-inspector-view");
    expect(host.getAttribute("data-desktop-inspector-view")).toBe("");
    expect(host.querySelector("h2")?.textContent).toBe("Inspector");
    expect(host.querySelector("p")?.textContent).toBe("Run detail");
    expect(Array.from(host.querySelectorAll(".desktop-inspector-view-row")).map((node) => node.textContent)).toEqual([
      "Status: completed",
      "Browser action: Open docs | https://example.test/docs",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty state when there are no rows", () => {
    const host = document.createElement("section");

    mountInspectorViewIsland(host, {
      emptyText: "Select something to inspect.",
      rows: [],
      title: "No selection",
    });

    expect(host.querySelector("h2")?.textContent).toBe("No selection");
    expect(host.querySelector(".desktop-inspector-view-empty")?.textContent).toBe("Select something to inspect.");
    expect(host.querySelector(".desktop-inspector-view-row")).toBeNull();
  });
});
