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
});
