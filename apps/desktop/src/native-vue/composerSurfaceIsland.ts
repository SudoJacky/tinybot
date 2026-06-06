import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { mountComposerRuntimeIsland } from "./composerRuntimeIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type ComposerSurfaceState = "idle" | "queued" | "sending";

export interface ComposerSurfaceSubmitEvent {
  content: string;
  usePersistentRag: boolean;
}

export interface ComposerSurfaceIslandOptions {
  activeSessionKey?: string | null;
  composerState: ComposerSurfaceState;
  model?: string | null;
  responding: boolean;
  tokenUsage: string;
  usePersistentRag: boolean;
  onAttach?: () => void;
  onPersistentRagChange?: (enabled: boolean) => void;
  onSend?: (event: ComposerSurfaceSubmitEvent) => void;
}

export interface MountedComposerSurfaceIsland {
  unmount: () => void;
}

export function mountComposerSurfaceIsland(
  host: HTMLElement,
  options: ComposerSurfaceIslandOptions,
): MountedComposerSurfaceIsland {
  applyComposerSurfaceHost(host, options);
  const app = createComposerSurfaceApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyComposerSurfaceHost(host: HTMLElement, options: ComposerSurfaceIslandOptions): void {
  host.id = "desktop-native-composer";
  host.className = "desktop-native-composer";
  host.setAttribute("data-desktop-vue-island", "composer-surface");
  host.setAttribute("aria-label", "Native desktop composer");
  if (options.activeSessionKey) {
    host.setAttribute("data-active-session-key", options.activeSessionKey);
  } else {
    host.removeAttribute("data-active-session-key");
  }
  host.setAttribute("data-desktop-composer-responding", String(options.responding));
  host.setAttribute("data-desktop-composer-rag", String(options.usePersistentRag));
  host.setAttribute("data-desktop-composer-state", options.composerState);
}

function createComposerSurfaceApp(options: ComposerSurfaceIslandOptions): App {
  return createApp(defineComponent({
    name: "ComposerSurfaceIsland",
    setup() {
      const content = ref("");
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const runtime = ref<HTMLElement | null>(null);
      const canSend = () => options.composerState === "idle" && Boolean(content.value.trim());
      const send = () => {
        if (!canSend()) {
          return;
        }
        options.onSend?.({
          content: content.value,
          usePersistentRag: options.usePersistentRag,
        });
      };

      onMounted(() => {
        mountChild(mountedChildren, runtime.value, (host) => mountComposerRuntimeIsland(host, {
          model: options.model,
          persistentRag: options.usePersistentRag,
          tokenUsage: options.tokenUsage,
          onPersistentRagChange: options.onPersistentRagChange,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", { class: "desktop-native-composer-layout" }, [
          h("textarea", {
            id: "desktop-native-composer-input",
            class: "desktop-native-composer-input",
            "aria-label": "Native composer input",
            placeholder: "Ask Tinybot",
            value: content.value,
            onInput: (event: Event) => {
              content.value = (event.target as HTMLTextAreaElement).value;
            },
          }),
          h("button", {
            id: "desktop-native-composer-attach",
            type: "button",
            class: "desktop-native-composer-action",
            "data-desktop-composer-action": "attach",
            "aria-label": "Attach temporary file to current session",
            onClick: () => options.onAttach?.(),
          }, h(NText, { strong: true }, { default: () => "+" })),
          h("div", { ref: runtime }),
          h("button", {
            id: "desktop-native-composer-send",
            type: "button",
            class: "desktop-native-composer-send",
            "data-desktop-composer-action": "send",
            "aria-label": "Send message",
            disabled: canSend() ? null : "",
            onClick: send,
          }, h(NText, { strong: true }, { default: () => "Send" })),
        ]),
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
