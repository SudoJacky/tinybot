import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NProgress } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface TokenUsageOrbIslandOptions {
  tokenUsage: string;
}

export interface MountedTokenUsageOrbIsland {
  unmount: () => void;
}

export function mountTokenUsageOrbIsland(
  host: HTMLElement,
  options: TokenUsageOrbIslandOptions,
): MountedTokenUsageOrbIsland {
  const percent = parseTokenUsagePercent(options.tokenUsage);
  applyTokenUsageHostContract(host, percent);
  const app = createTokenUsageOrbApp(percent);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createTokenUsageOrbApp(percent: number): App {
  return createApp(defineComponent({
    name: "TokenUsageOrbIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NProgress, {
          class: "desktop-native-token-progress",
          percentage: percent,
          showIndicator: true,
          type: "circle",
        }),
      });
    },
  }));
}

function applyTokenUsageHostContract(host: HTMLElement, percent: number): void {
  host.setAttribute("data-desktop-vue-island", "token-usage-orb");
  host.className = "desktop-native-token-orb";
  host.setAttribute("role", "meter");
  host.setAttribute("aria-label", `Token usage ${percent}%`);
  host.setAttribute("aria-valuemin", "0");
  host.setAttribute("aria-valuemax", "100");
  host.setAttribute("aria-valuenow", String(percent));
  host.setAttribute("data-token-usage", String(percent));
  host.style.setProperty("--token-usage-fill", `${percent}%`);
}

function parseTokenUsagePercent(tokenUsage: string): number {
  const match = tokenUsage.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return 0;
  }
  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
