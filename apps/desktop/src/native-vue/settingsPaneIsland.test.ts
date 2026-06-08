// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { mountSettingsPaneIsland } from "./settingsPaneIsland";

const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];

const savedState = buildDesktopSettingsFormState({
  agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
  providers: {
    profiles: {
      work: {
        provider: "openai",
        api_key: "sk-live",
        api_base: "https://api.openai.com/v1",
        models: ["gpt-4.1-mini"],
      },
    },
  },
}, providerCatalog);

const draftState = buildDesktopSettingsFormState({
  agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
  providers: {
    profiles: {
      work: {
        provider: "openai",
        api_key: "sk-live",
        api_base: "https://api.openai.com/v1",
        models: ["gpt-4.1", "gpt-4.1-mini"],
      },
    },
  },
  knowledge: { enabled: true },
}, providerCatalog);

const pane = buildDesktopSettingsPaneModel(draftState, {
  lastSavedState: savedState,
  providerCatalog,
  saveStatus: "idle",
});

describe("settings pane Vue island", () => {
  test("renders settings shell and forwards settings actions", () => {
    const host = document.createElement("section");
    const focused: string[] = [];
    const actions: string[] = [];

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      onFocusSettingsControl: (fieldId) => focused.push(fieldId),
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        actions.push(event.action);
      },
      promptProviderId: () => "openai",
    });

    expect(host.className).toBe("desktop-workbench-section desktop-settings-pane");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("settings");
    expect(host.getAttribute("data-settings-layout")).toBe("capability-center");
    expect(host.getAttribute("aria-label")).toBe("Settings and providers");

    expect(host.querySelector(".desktop-settings-sidebar")?.textContent).toContain("General");
    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / Capability Center");
    expect(host.querySelector(".desktop-settings-capability-map")?.getAttribute("data-desktop-settings-center")).toBe("capability-boundaries");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-capability]"),
      (node) => node.getAttribute("data-desktop-settings-capability"),
    )).toEqual([
      "provider-models",
      "knowledge",
      "tools-approvals",
      "files-workspace",
      "gateway-runtime",
      "logs-diagnostics",
    ]);
    expect(host.querySelector('[data-desktop-settings-capability="provider-models"]')?.textContent).toContain("OpenAI");
    expect(host.querySelector('[data-desktop-settings-capability="knowledge"]')?.textContent).toContain("Knowledge On");
    expect(host.querySelector('[data-desktop-settings-capability="tools-approvals"]')?.textContent).toContain("Shell Off");
    expect(host.querySelector('[data-desktop-settings-capability="gateway-runtime"]')?.textContent).toContain("Gateway");
    expect(host.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("Default LLM");
    expect(host.querySelector(".desktop-settings-provider-section")?.textContent).toContain("Providers");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("OpenAI");
    expect(host.querySelector(".desktop-settings-status-card")).toBeNull();
    expect(host.querySelector('[data-desktop-settings-group="knowledge"]')?.textContent).toContain("Knowledge");

    const model = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="model"]');
    model!.value = "gpt-4.1-mini";
    model?.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="settings"]')?.click();

    expect(actions).toEqual([
      "edit:model:gpt-4.1-mini",
      "save",
      "discoverModels",
    ]);
    expect(focused).toEqual(["apiBase"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
