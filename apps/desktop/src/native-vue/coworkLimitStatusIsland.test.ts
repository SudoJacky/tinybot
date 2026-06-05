// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountCoworkLimitStatusIsland } from "./coworkLimitStatusIsland";

describe("cowork limit status Vue island", () => {
  test("renders visible total status", () => {
    const host = document.createElement("p");

    const mounted = mountCoworkLimitStatusIsland(host, {
      text: "Showing 2 of 4 rows",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-limit-status");
    expect(host.className).toBe("desktop-cowork-limit-status");
    expect(host.textContent).toBe("Showing 2 of 4 rows");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders filtered matching status", () => {
    const host = document.createElement("p");

    mountCoworkLimitStatusIsland(host, {
      text: "Showing 1 of 2 matching rows (5 total)",
    });

    expect(host.className).toBe("desktop-cowork-limit-status");
    expect(host.textContent).toBe("Showing 1 of 2 matching rows (5 total)");
  });
});
