// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountFormatChipListIsland } from "./formatChipListIsland";

describe("format chip list Vue island", () => {
  test("renders format label and chips", () => {
    const host = document.createElement("p");

    const mounted = mountFormatChipListIsland(host, {
      formats: [".md", ".txt", ".pdf"],
      id: "desktop-file-formats",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("format-chip-list");
    expect(host.id).toBe("desktop-file-formats");
    expect(host.className).toBe("desktop-file-format-row");
    expect(host.querySelector("span")?.textContent).toBe("Formats:");
    expect(Array.from(host.querySelectorAll(".desktop-file-format-chip")).map((chip) => chip.textContent)).toEqual([
      ".md",
      ".txt",
      ".pdf",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders only the label when there are no formats", () => {
    const host = document.createElement("p");

    mountFormatChipListIsland(host, {
      formats: [],
      id: "empty-formats",
    });

    expect(host.textContent).toBe("Formats:");
    expect(host.querySelector(".desktop-file-format-chip")).toBeNull();
  });
});
