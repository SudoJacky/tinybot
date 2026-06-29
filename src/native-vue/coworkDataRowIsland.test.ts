// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountCoworkDataRowIsland } from "./coworkDataRowIsland";

describe("cowork data row Vue island", () => {
  test("renders Cowork data row class and text", () => {
    const host = document.createElement("p");

    const mounted = mountCoworkDataRowIsland(host, {
      className: "desktop-cowork-observability-row",
      text: "Planner lane: ready",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-data-row");
    expect(host.className).toBe("desktop-cowork-observability-row");
    expect(host.textContent).toBe("Planner lane: ready");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders task feed rows with their caller-provided class", () => {
    const host = document.createElement("p");

    mountCoworkDataRowIsland(host, {
      className: "desktop-cowork-task-feed-row",
      text: "Draft answer: running / Waiting for helper",
    });

    expect(host.className).toBe("desktop-cowork-task-feed-row");
    expect(host.textContent).toBe("Draft answer: running / Waiting for helper");
  });
});
