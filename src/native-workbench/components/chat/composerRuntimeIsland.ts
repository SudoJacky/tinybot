import { createApp, defineComponent, h, ref, type App, type PropType, type Ref } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface ComposerRuntimeIslandOptions {
  model?: string | null;
  modelOptions?: string[];
  persistentRag: boolean;
  tokenUsage: string;
  onModelSelect?: (model: string) => void;
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
        default: () => h(ComposerRuntimeContent, { options }),
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
  }, h(ComposerRuntimeContent, { options }));
}

const ComposerRuntimeContent = defineComponent({
  name: "ComposerRuntimeContent",
  props: {
    options: {
      type: Object as PropType<ComposerRuntimeIslandOptions>,
      required: true,
    },
  },
  setup(props) {
    const modelMenuOpen = ref(false);
    return () => renderComposerRuntimeContent(props.options, modelMenuOpen);
  },
});

export function renderComposerRuntimeContent(options: ComposerRuntimeIslandOptions, modelMenuOpen: Ref<boolean>) {
  return [
    renderModelControl(options, modelMenuOpen),
    renderPersistentRagToggle(options),
    renderTokenUsageOrb(options.tokenUsage),
  ];
}

function renderModelControl(options: ComposerRuntimeIslandOptions, modelMenuOpen: Ref<boolean>) {
  const currentModel = options.model || "Tinybot Pro";
  const modelOptions = normalizeComposerModelOptions(currentModel, options.modelOptions);
  return h("button", {
    type: "button",
    class: "desktop-native-composer-model",
    "data-desktop-composer-action": "model-select",
    "aria-label": "Select model",
    onClick: () => {
      modelMenuOpen.value = !modelMenuOpen.value;
    },
  }, [
    h("span", { class: "desktop-native-composer-model-label" }, h(NText, { strong: true }, { default: () => currentModel })),
    modelMenuOpen.value ? h("span", {
      class: "desktop-native-composer-model-menu",
      role: "listbox",
      "aria-label": "Model",
      onClick: (event: MouseEvent) => event.stopPropagation(),
    }, [
      h("span", { class: "desktop-native-composer-model-menu-title" }, "Model"),
      ...modelOptions.map((model) => h("span", {
        key: model,
        class: "desktop-native-composer-model-option",
        role: "option",
        "aria-selected": String(model === currentModel),
        "data-desktop-composer-model-option": model,
        onClick: (event: MouseEvent) => {
          event.stopPropagation();
          modelMenuOpen.value = false;
          options.onModelSelect?.(model);
        },
      }, [
        h("span", { class: "desktop-native-composer-model-option-label" }, model),
        model === currentModel ? renderModelCheckIcon() : null,
      ])),
    ]) : null,
  ]);
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

function normalizeComposerModelOptions(currentModel: string, modelOptions: string[] | undefined): string[] {
  const options = (modelOptions ?? [])
    .map((model) => model.trim())
    .filter(Boolean);
  if (currentModel && !options.includes(currentModel)) {
    options.unshift(currentModel);
  }
  return Array.from(new Set(options));
}

function renderModelCheckIcon() {
  return h("svg", {
    class: "desktop-native-composer-model-check",
    "aria-hidden": "true",
    viewBox: "0 0 20 20",
    focusable: "false",
  }, h("path", {
    d: "M16.5 5.5 8.25 13.75 4 9.5",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }));
}
