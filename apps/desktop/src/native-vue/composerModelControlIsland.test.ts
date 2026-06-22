// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountComposerModelControlIsland } from "./composerModelControlIsland";

describe("composer model control Vue island", () => {
  test("renders a selectable desktop composer model menu", async () => {
    const host = document.createElement("button");
    const selections: string[] = [];

    const mounted = mountComposerModelControlIsland(host, {
      model: "deepseek-chat",
      modelOptions: ["deepseek-chat", "deepseek-reasoner"],
      onModelSelect: (model) => selections.push(model),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-model-control");
    expect(host.className).toContain("desktop-native-composer-model");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("aria-label")).toBe("Select model");
    expect(host.textContent).toContain("deepseek-chat");
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    host.click();
    await nextTick();
    const menu = host.querySelector('[role="listbox"]');
    expect(menu?.textContent).toContain("Model");
    expect(menu?.textContent).toContain("deepseek-chat");
    expect(menu?.textContent).toContain("deepseek-reasoner");
    expect(menu?.querySelector('[aria-selected="true"]')?.textContent).toContain("deepseek-chat");

    host.querySelector<HTMLButtonElement>('[data-desktop-composer-model-option="deepseek-reasoner"]')?.click();
    expect(selections).toEqual(["deepseek-reasoner"]);

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
