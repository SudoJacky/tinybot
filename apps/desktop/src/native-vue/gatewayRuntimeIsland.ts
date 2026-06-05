import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeDiagnostics,
  buildDesktopGatewayRuntimeRows,
  type DesktopGatewayRuntimeActionId,
} from "../desktopGatewayRuntimeControls";
import type { GatewayRuntimeStatus } from "../desktopGatewayStartup";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface GatewayRuntimeIslandActionEvent {
  action: DesktopGatewayRuntimeActionId;
  status: GatewayRuntimeStatus | null;
  diagnostics: string;
}

export interface GatewayRuntimeIslandOptions {
  gatewayHttp: string;
  status: GatewayRuntimeStatus | null;
  onAction?: (event: GatewayRuntimeIslandActionEvent) => void;
}

export interface MountedGatewayRuntimeIsland {
  unmount: () => void;
}

export function mountGatewayRuntimeIsland(
  host: HTMLElement,
  options: GatewayRuntimeIslandOptions,
): MountedGatewayRuntimeIsland {
  host.setAttribute("data-desktop-vue-island", "gateway-runtime");
  const app = createGatewayRuntimeApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createGatewayRuntimeApp(options: GatewayRuntimeIslandOptions): App {
  return createApp(defineComponent({
    name: "GatewayRuntimeIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("section", {
          class: "desktop-workbench-section desktop-gateway-runtime",
          "aria-label": "Gateway runtime controls",
        }, [
          h("h2", "Runtime"),
          ...buildDesktopGatewayRuntimeRows(options.status, options.gatewayHttp).map((row) => h("p", {
            class: "desktop-gateway-runtime-row",
            "data-desktop-gateway-runtime-row": row.label,
          }, [
            h("span", { class: "desktop-gateway-runtime-label" }, row.label),
            h("span", { class: "desktop-gateway-runtime-value" }, row.value),
          ])),
          h(NSpace, {
            class: "desktop-gateway-actions",
            role: "group",
            "aria-label": "Gateway runtime actions",
            size: 8,
          }, {
            default: () => buildDesktopGatewayRuntimeActions(options.status).map((action) => h(NButton, {
              class: "desktop-gateway-action",
              "data-desktop-gateway-action": action.id,
              size: "small",
              secondary: true,
              type: gatewayPrimaryAction(action.id),
              onClick: () => handleAction(action.id, options),
            }, { default: () => action.label })),
          }),
        ]),
      });
    },
  }));
}

function handleAction(action: DesktopGatewayRuntimeActionId, options: GatewayRuntimeIslandOptions): void {
  options.onAction?.({
    action,
    status: options.status,
    diagnostics: buildDesktopGatewayRuntimeDiagnostics(options.status, options.gatewayHttp),
  });
}

function gatewayPrimaryAction(action: DesktopGatewayRuntimeActionId): "primary" | "default" {
  return action === "start" || action === "retry" ? "primary" : "default";
}
