import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ComposerRuntimeIslandOptions {
  model?: string | null;
  persistentRag: boolean;
  tokenUsage: string;
  onPersistentRagChange?: (enabled: boolean) => void;
}

export interface MountedComposerRuntimeIsland {
  unmount: () => void;
}

export function mountComposerRuntimeIsland(
  host: HTMLElement,
  options: ComposerRuntimeIslandOptions,
): MountedComposerRuntimeIsland {
  applyComposerRuntimeHost(host);
  const app = createComposerRuntimeApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyComposerRuntimeHost(host: HTMLElement): void {
  host.id = "desktop-native-composer-runtime";
  host.className = "desktop-native-composer-runtime";
  host.setAttribute("data-desktop-vue-island", "composer-runtime");
  host.setAttribute("data-desktop-composer-region", "runtime-status");
  host.setAttribute("aria-label", "Runtime status");
}

function createComposerRuntimeApp(options: ComposerRuntimeIslandOptions): App {
  return createApp(defineComponent({
    name: "ComposerRuntimeIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderComposerRuntimeContent(options),
      });
    },
  }));
}

export function renderComposerRuntimeSurface(options: ComposerRuntimeIslandOptions) {
  return h("div", {
    id: "desktop-native-composer-runtime",
    class: "desktop-native-composer-runtime",
    "data-desktop-vue-island": "composer-runtime",
    "data-desktop-composer-region": "runtime-status",
    "aria-label": "Runtime status",
  }, renderComposerRuntimeContent(options));
}

export function renderComposerRuntimeContent(options: ComposerRuntimeIslandOptions) {
  return [
    renderModelControl(options.model),
    renderPersistentRagToggle(options),
    renderTokenUsageOrb(options.tokenUsage),
  ];
}

function renderModelControl(model?: string | null) {
  return h("button", {
    type: "button",
    class: "desktop-native-composer-model",
    "aria-label": "Select model",
  }, h(NText, { strong: true }, { default: () => model || "Tinybot Pro" }));
}

function renderPersistentRagToggle(options: ComposerRuntimeIslandOptions) {
  return h("button", {
    type: "button",
    class: "desktop-native-composer-model desktop-native-composer-rag-toggle",
    "data-desktop-composer-action": "rag-toggle",
    "aria-label": "Toggle persistent RAG",
    "aria-pressed": String(options.persistentRag),
    onClick: () => options.onPersistentRagChange?.(!options.persistentRag),
  }, h(NText, { strong: true }, { default: () => "RAG" }));
}

function renderTokenUsageOrb(tokenUsage: string) {
  const percent = parseTokenUsagePercent(tokenUsage);
  return h("span", {
    class: "desktop-native-token-orb",
    role: "meter",
    "aria-label": `Token usage ${percent}%`,
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": String(percent),
    "data-token-usage": String(percent),
    style: { "--token-usage-fill": `${percent}%` },
  }, `${percent}%`);
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
