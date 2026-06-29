// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopRunChainItem } from "../../shell/desktopRunChainInspector";
import { mountRunChainInspectorIsland } from "./runChainInspectorIsland";

const runChainItems: DesktopRunChainItem[] = [
  {
    key: "m-context:citation:cite-1",
    kind: "citation",
    title: "Spec citation",
    preview: "URL: https://example.test/spec",
    status: "completed",
    inspectable: true,
    detailTitle: "Spec citation",
    detailSubtitle: "Citation detail",
    detailSections: [{ type: "text", label: "URL", text: "https://example.test/spec" }],
  },
  {
    key: "m-plan:planning",
    kind: "planning",
    title: "Planning",
    preview: "Inspect the active context",
    status: "completed",
    inspectable: true,
    detailTitle: "Planning",
    detailSubtitle: "Thinking trace",
    detailSections: [{ type: "text", label: "Thinking", text: "Inspect the active context" }],
  },
];

describe("run chain inspector Vue island", () => {
  test("renders selectable run-chain items and selected detail", async () => {
    const host = document.createElement("section");
    const selected: string[] = [];

    const mounted = mountRunChainInspectorIsland(host, {
      items: runChainItems,
      selectedItemKey: "m-context:citation:cite-1",
      onSelect: (item) => selected.push(item.key),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("run-chain-inspector");
    expect(host.className).toBe("desktop-workbench-section desktop-run-chain-inspector");
    expect(host.getAttribute("aria-label")).toBe("Run-chain inspector");
    expect(host.querySelector("h2")?.textContent).toBe("Run-chain inspector");
    expect(host.querySelector(".desktop-run-chain-list")?.getAttribute("role")).toBe("listbox");
    expect(Array.from(host.querySelectorAll(".desktop-run-chain-item")).map((row) => row.getAttribute("data-desktop-run-chain-item"))).toEqual([
      "m-context:citation:cite-1",
      "m-plan:planning",
    ]);
    expect(host.querySelector('[data-desktop-run-chain-item="m-context:citation:cite-1"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-detail")?.textContent).toContain("Spec citation");
    expect(host.querySelector(".desktop-run-chain-detail")?.textContent).toContain("URL: https://example.test/spec");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-item="m-plan:planning"]')?.click();
    await nextTick();

    expect(host.querySelector('[data-desktop-run-chain-item="m-context:citation:cite-1"]')?.getAttribute("aria-selected")).toBe("false");
    expect(host.querySelector('[data-desktop-run-chain-item="m-plan:planning"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-detail")?.textContent).toContain("Thinking: Inspect the active context");
    expect(selected).toEqual(["m-plan:planning"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
