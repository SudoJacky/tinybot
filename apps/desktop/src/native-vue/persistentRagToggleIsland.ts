import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface PersistentRagToggleIslandOptions {
  enabled: boolean;
  onToggle?: (enabled: boolean) => void;
}

export interface MountedPersistentRagToggleIsland {
  unmount: () => void;
}

export function mountPersistentRagToggleIsland(
  host: HTMLElement,
  options: PersistentRagToggleIslandOptions,
): MountedPersistentRagToggleIsland {
  host.setAttribute("data-desktop-vue-island", "persistent-rag-toggle");
  host.setAttribute("type", "button");
  host.className = "desktop-native-composer-model desktop-native-composer-rag-toggle";
  host.setAttribute("data-desktop-composer-action", "rag-toggle");
  host.setAttribute("aria-label", "Toggle persistent RAG");
  host.setAttribute("aria-pressed", String(options.enabled));
  host.addEventListener("click", () => {
    options.onToggle?.(!options.enabled);
  });
  const app = createPersistentRagToggleApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createPersistentRagToggleApp(options: PersistentRagToggleIslandOptions): App {
  return createApp(defineComponent({
    name: "PersistentRagToggleIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => `RAG ${options.enabled ? "On" : "Off"}` }),
      });
    },
  }));
}
