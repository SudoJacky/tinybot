// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";

describe("desktop settings renderer ownership", () => {
  test("mounts the normal settings Vue app without preconstructing the imperative settings page", async () => {
    vi.resetModules();
    const mountObservations: Array<{ className: string; childCount: number; hasImperativeContent: boolean }> = [];
    const mountSettingsPaneIsland = vi.fn((host: HTMLElement) => {
      mountObservations.push({
        className: host.className,
        childCount: host.children.length,
        hasImperativeContent: Boolean(host.querySelector(".desktop-settings-content")),
      });
      host.setAttribute("data-desktop-vue-island", "settings-pane");
      return {
        unmount: () => undefined,
        update: () => undefined,
      };
    });
    vi.doMock("./native-vue/settingsPaneIsland", () => ({
      mountOrUpdateSettingsPaneIsland: vi.fn(),
      mountSettingsPaneIsland,
    }));
    const [
      { buildDesktopSettingsFormState, buildDesktopSettingsPaneModel },
      { createDefaultWorkbenchLayout },
      { installDesktopWorkbenchShell },
    ] = await Promise.all([
      import("./desktopSettingsProviders"),
      import("./desktopWorkbenchLayout"),
      import("./desktopWorkbenchShell"),
    ]);

    document.body.replaceChildren();
    document.head.replaceChildren();
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "deepseek-chat", provider: "deepseek", active_profile: "work" } },
      providers: { profiles: { work: { provider: "deepseek", api_key: "sk-live", models: ["deepseek-chat"] } } },
    }, [{ id: "deepseek", displayName: "DeepSeek", status: "ready" }]);

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      settingsPane: buildDesktopSettingsPaneModel(state, {
        lastSavedState: state,
        providerCatalog: [{ id: "deepseek", displayName: "DeepSeek", status: "ready" }],
      }),
    });

    const workbenchSettingsPaneMount = mountObservations.find((observation) => observation.className.includes("desktop-settings-pane"));
    expect(workbenchSettingsPaneMount).toEqual({
      className: "desktop-workbench-section desktop-settings-pane",
      childCount: 0,
      hasImperativeContent: false,
    });
  }, 30000);

  test("renders redesigned settings pages through the fallback shell renderer", async () => {
    vi.resetModules();
    const originalHTMLElement = globalThis.HTMLElement;
    vi.stubGlobal("HTMLElement", undefined);
    try {
      const [
        { buildDesktopSettingsFormState, buildDesktopSettingsPaneModel },
        { createDefaultWorkbenchLayout },
        { installDesktopWorkbenchShell },
      ] = await Promise.all([
        import("./desktopSettingsProviders"),
        import("./desktopWorkbenchLayout"),
        import("./desktopWorkbenchShell"),
      ]);

      document.body.replaceChildren();
      document.head.replaceChildren();
      const state = buildDesktopSettingsFormState({
        agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
        providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: ["gpt-4.1-mini"] } } },
        knowledge: { enabled: true, retrieval_mode: "hybrid", max_chunks: 5 },
      }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

      installDesktopWorkbenchShell({
        targetDocument: document,
        layout: createDefaultWorkbenchLayout(),
        gatewayHttp: "http://127.0.0.1:18790",
        settingsPane: buildDesktopSettingsPaneModel(state, {
          lastSavedState: state,
          providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
        }),
      });

      const settingsPane = document.querySelector(".desktop-settings-pane");
      expect(settingsPane?.getAttribute("data-desktop-vue-island")).toBeNull();
      expect(settingsPane?.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("General");
      expect(settingsPane?.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("Default AI");

      settingsPane?.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]')?.click();
      expect(settingsPane?.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Provider & Models");
      expect(settingsPane?.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Edit OpenAI");

      settingsPane?.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="knowledge"]')?.click();
      expect(settingsPane?.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Knowledge");
      expect(Array.from(
        settingsPane?.querySelectorAll("[data-desktop-settings-knowledge-stage]") ?? [],
        (node) => node.getAttribute("data-desktop-settings-knowledge-stage"),
      )).toEqual(["documents", "chunking", "embeddings", "retrieval", "rerank", "graph"]);
    } finally {
      vi.stubGlobal("HTMLElement", originalHTMLElement);
    }
  }, 30000);
});
