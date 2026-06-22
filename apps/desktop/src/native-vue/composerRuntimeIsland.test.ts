// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountComposerRuntimeIsland } from "./composerRuntimeIsland";

describe("composer runtime Vue island", () => {
  test("renders runtime affordances and dispatches RAG toggles", async () => {
    const host = document.createElement("div");
    const modelSelections: string[] = [];
    const toggles: boolean[] = [];

    const mounted = mountComposerRuntimeIsland(host, {
      model: "deepseek-chat",
      modelOptions: ["deepseek-chat", "deepseek-reasoner"],
      persistentRag: false,
      tokenUsage: "42%",
      onModelSelect: (model) => modelSelections.push(model),
      onPersistentRagChange: (enabled) => toggles.push(enabled),
    });

    expect(host.id).toBe("desktop-native-composer-runtime");
    expect(host.className).toBe("desktop-native-composer-runtime");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-runtime");
    expect(host.getAttribute("data-desktop-composer-region")).toBe("runtime-status");
    expect(host.getAttribute("aria-label")).toBe("Runtime status");

    expect(host.querySelector(".desktop-native-composer-model")?.textContent).toContain("deepseek-chat");
    const rag = host.querySelector<HTMLElement>('[data-desktop-composer-action="rag-toggle"]');
    expect(rag?.textContent).toBe("RAG");
    expect(rag?.textContent).not.toContain("On");
    expect(rag?.textContent).not.toContain("Off");
    expect(rag?.getAttribute("aria-pressed")).toBe("false");
    const token = host.querySelector<HTMLElement>(".desktop-native-token-orb");
    expect(token?.getAttribute("aria-label")).toBe("Token usage 42%");
    expect(token?.getAttribute("data-token-usage")).toBe("42");
    expect(token?.style.getPropertyValue("--token-usage-fill")).toBe("42%");

    host.querySelector<HTMLButtonElement>('[data-desktop-composer-action="model-select"]')?.click();
    await nextTick();
    expect(host.querySelector('[role="listbox"]')?.textContent).toContain("deepseek-reasoner");
    host.querySelector<HTMLButtonElement>('[data-desktop-composer-model-option="deepseek-reasoner"]')?.click();
    rag?.click();
    expect(modelSelections).toEqual(["deepseek-reasoner"]);
    expect(toggles).toEqual([true]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
