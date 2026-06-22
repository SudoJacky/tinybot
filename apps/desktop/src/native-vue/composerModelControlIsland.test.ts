// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountComposerModelControlIsland } from "./composerModelControlIsland";

describe("composer model control Vue island", () => {
  test("renders the desktop composer model selector host", () => {
    const host = document.createElement("button");
    const selections: string[] = [];

    const mounted = mountComposerModelControlIsland(host, {
      model: "deepseek-chat",
      onModelSelect: () => selections.push("model"),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-model-control");
    expect(host.className).toContain("desktop-native-composer-model");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("aria-label")).toBe("Select model");
    expect(host.textContent).toContain("deepseek-chat");

    host.click();
    expect(selections).toEqual(["model"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders the default model label when no model is provided", () => {
    const host = document.createElement("button");

    const mounted = mountComposerModelControlIsland(host, {});

    expect(host.textContent).toContain("Tinybot Pro");

    mounted.unmount();
  });
});
