// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountPersistentRagToggleIsland } from "./persistentRagToggleIsland";

describe("persistent RAG toggle Vue island", () => {
  test("renders enabled state and dispatches the next RAG value", () => {
    const host = document.createElement("button");
    const toggled: boolean[] = [];

    const mounted = mountPersistentRagToggleIsland(host, {
      enabled: true,
      onToggle: (enabled) => toggled.push(enabled),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("persistent-rag-toggle");
    expect(host.className).toContain("desktop-native-composer-model");
    expect(host.className).toContain("desktop-native-composer-rag-toggle");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-desktop-composer-action")).toBe("rag-toggle");
    expect(host.getAttribute("aria-label")).toBe("Toggle persistent RAG");
    expect(host.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toBe("RAG");
    expect(host.textContent).not.toContain("On");
    expect(host.textContent).not.toContain("Off");

    host.click();
    expect(toggled).toEqual([false]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders disabled state", () => {
    const host = document.createElement("button");

    const mounted = mountPersistentRagToggleIsland(host, {
      enabled: false,
    });

    expect(host.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toBe("RAG");
    expect(host.textContent).not.toContain("On");
    expect(host.textContent).not.toContain("Off");

    mounted.unmount();
  });
});
