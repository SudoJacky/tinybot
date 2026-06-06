import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SettingsStatusIslandOptions {
  pane: DesktopSettingsPaneModel;
}

export interface MountedSettingsStatusIsland {
  unmount: () => void;
}

export function mountSettingsStatusIsland(
  host: HTMLElement,
  options: SettingsStatusIslandOptions,
): MountedSettingsStatusIsland {
  host.setAttribute("data-desktop-vue-island", "settings-status");
  host.className = "desktop-settings-status-card";
  host.setAttribute("aria-label", "Settings status");
  const app = createSettingsStatusApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsStatusApp(options: SettingsStatusIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsStatusIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => h("div", { class: "desktop-settings-summary" }, statusRows(options.pane).map((row) => renderStatusItem(row))),
        }),
      });
    },
  }));
}

function statusRows(pane: DesktopSettingsPaneModel): Array<{ label: string; value: string; tone?: "default" | "error" | "success" | "warning" }> {
  return [
    { label: "Save", value: pane.save.message, tone: saveTone(pane.save.status) },
    {
      label: "Validation",
      value: pane.validationErrors.length ? pane.validationErrors.map((error) => error.field).join(", ") : "ready",
      tone: pane.validationErrors.length ? "error" : "success",
    },
    { label: "Provider profile", value: pane.providerEditor.profileId || "default" },
    { label: "API key", value: pane.providerEditor.apiKey.displayValue || "Not configured" },
    {
      label: "Catalog",
      value: pane.providerCatalog.map((provider) => `${provider.label} (${provider.status})`).join(", ") || "No providers loaded",
    },
    { label: "Models", value: pane.providerEditor.models.join(", ") || "No models loaded" },
  ];
}

function renderStatusItem(row: { label: string; value: string; tone?: "default" | "error" | "success" | "warning" }) {
  return h("p", { class: "desktop-settings-status-item" }, [
    h("span", `${row.label}: `),
    h("strong", row.value),
    row.tone ? h(NSpace, { size: 4, inline: true }, {
      default: () => h(NTag, { size: "small", round: true, type: row.tone }, { default: () => row.value }),
    }) : null,
  ]);
}

function saveTone(status: DesktopSettingsPaneModel["save"]["status"]): "default" | "error" | "success" | "warning" {
  if (status === "saved") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "saving") {
    return "warning";
  }
  return "default";
}
