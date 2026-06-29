import { createApp, defineComponent, h, onMounted, ref, type App, type Ref } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { logDesktopNativeChatDebug } from "../../native/desktopNativeChatDebug";
import { renderComposerRuntimeSurface } from "./composerRuntimeIsland";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export type ComposerSurfaceState = "idle" | "queued" | "sending";

export interface ComposerSurfaceSubmitEvent {
  content: string;
  usePersistentRag: boolean;
}

export interface ComposerSurfaceIslandOptions {
  activeSessionKey?: string | null;
  composerState: ComposerSurfaceState;
  model?: string | null;
  modelOptions?: string[];
  responding: boolean;
  tokenUsage: string;
  usePersistentRag: boolean;
  onAttach?: () => void;
  onModelSelect?: (model: string) => void;
  onPersistentRagChange?: (enabled: boolean) => void;
  onSend?: (event: ComposerSurfaceSubmitEvent) => void;
}

export interface MountedComposerSurfaceIsland {
  update: (options: ComposerSurfaceIslandOptions) => void;
  unmount: () => void;
}

const mountedComposerSurfaces = new WeakMap<HTMLElement, MountedComposerSurfaceIsland>();

export function mountOrUpdateComposerSurfaceIsland(
  host: HTMLElement,
  options: ComposerSurfaceIslandOptions,
): MountedComposerSurfaceIsland {
  logDesktopNativeChatDebug("vue.composer.update", summarizeComposerSurfaceOptions(options, host));
  const mounted = mountedComposerSurfaces.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  const nextMounted = mountComposerSurfaceIsland(host, options);
  mountedComposerSurfaces.set(host, nextMounted);
  return nextMounted;
}

function summarizeComposerSurfaceOptions(
  options: ComposerSurfaceIslandOptions,
  host: HTMLElement,
): Record<string, unknown> {
  const input = host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input");
  const send = host.querySelector<HTMLButtonElement>("#desktop-native-composer-send");
  return {
    activeSessionKey: options.activeSessionKey ?? "",
    composerState: options.composerState,
    draftLength: input?.value.length ?? 0,
    model: options.model ?? "",
    responding: options.responding,
    sendDisabled: send?.disabled ?? null,
    tokenUsage: options.tokenUsage,
    usePersistentRag: options.usePersistentRag,
  };
}

export function mountComposerSurfaceIsland(
  host: HTMLElement,
  options: ComposerSurfaceIslandOptions,
): MountedComposerSurfaceIsland {
  applyComposerSurfaceHost(host, options);
  const state = ref(options);
  const app = createComposerSurfaceApp(state);
  app.mount(host);
  return {
    update: (nextOptions) => {
      applyComposerSurfaceHost(host, nextOptions);
      state.value = nextOptions;
    },
    unmount: () => {
      mountedComposerSurfaces.delete(host);
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

function createComposerSurfaceApp(state: Ref<ComposerSurfaceIslandOptions>): App {
  return createApp(defineComponent({
    name: "ComposerSurfaceIsland",
    setup() {
      const content = ref("");
      const input = ref<HTMLTextAreaElement | null>(null);
      const canSend = () => state.value.composerState === "idle" && Boolean(content.value.trim());
      const send = () => {
        if (!canSend()) {
          return;
        }
        state.value.onSend?.({
          content: content.value,
          usePersistentRag: state.value.usePersistentRag,
        });
        content.value = "";
        resizeComposerInput(input.value);
      };

      onMounted(() => {
        resizeComposerInput(input.value);
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", { class: "desktop-native-composer-layout" }, [
          h("textarea", {
            ref: input,
            id: "desktop-native-composer-input",
            class: "desktop-native-composer-input",
            "aria-label": "Native composer input",
            placeholder: "Ask Tinybot",
            rows: 1,
            "data-max-rows": "3",
            value: content.value,
            onInput: (event: Event) => {
              const target = event.target as HTMLTextAreaElement;
              content.value = target.value;
              resizeComposerInput(target);
            },
          }),
          h("button", {
            id: "desktop-native-composer-attach",
            type: "button",
            class: "desktop-native-composer-action",
            "data-desktop-composer-action": "attach",
            "aria-label": "Attach temporary file to current session",
            onClick: () => state.value.onAttach?.(),
          }, h(NText, { strong: true }, { default: () => "+" })),
          renderComposerRuntimeSurface({
            model: state.value.model,
            modelOptions: state.value.modelOptions,
            persistentRag: state.value.usePersistentRag,
            tokenUsage: state.value.tokenUsage,
            onModelSelect: state.value.onModelSelect,
            onPersistentRagChange: state.value.onPersistentRagChange,
          }),
          h("button", {
            id: "desktop-native-composer-send",
            type: "button",
            class: "desktop-native-composer-send",
            "data-desktop-composer-action": "send",
            "aria-label": "Send message",
            disabled: canSend() ? null : "",
            onClick: send,
          }, renderSendIcon()),
        ]),
      });
    },
  }));
}

function resizeComposerInput(input: HTMLTextAreaElement | null): void {
  if (!input) {
    return;
  }
  const lineHeight = 24;
  const maxHeight = lineHeight * 3;
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight || lineHeight, lineHeight), maxHeight)}px`;
}

function renderSendIcon() {
  return h("svg", {
    "data-desktop-composer-send-icon": "true",
    "aria-hidden": "true",
    viewBox: "0 0 20 20",
    focusable: "false",
  }, [
    h("path", {
      d: "M3 10h12m0 0-5-5m5 5-5 5",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  ]);
}
