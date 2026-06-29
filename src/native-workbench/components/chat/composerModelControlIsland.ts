import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface ComposerModelControlIslandOptions {
  model?: string | null;
  modelOptions?: string[];
  onModelSelect?: (model: string) => void;
}

export interface MountedComposerModelControlIsland {
  unmount: () => void;
}

export function mountComposerModelControlIsland(
  host: HTMLElement,
  options: ComposerModelControlIslandOptions,
): MountedComposerModelControlIsland {
  host.setAttribute("data-desktop-vue-island", "composer-model-control");
  host.setAttribute("type", "button");
  host.className = "desktop-native-composer-model";
  host.setAttribute("aria-label", "Select model");
  host.setAttribute("data-desktop-composer-action", "model-select");
  const app = createComposerModelControlApp(host, options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createComposerModelControlApp(host: HTMLElement, options: ComposerModelControlIslandOptions): App {
  return createApp(defineComponent({
    name: "ComposerModelControlIsland",
    setup() {
      const open = ref(false);
      const toggleOpen = () => {
        open.value = !open.value;
      };
      const currentModel = () => options.model || "Tinybot Pro";
      const modelOptions = () => normalizeComposerModelOptions(currentModel(), options.modelOptions);
      const selectModel = (event: MouseEvent, model: string) => {
        event.stopPropagation();
        open.value = false;
        options.onModelSelect?.(model);
      };
      onMounted(() => {
        host.addEventListener("click", toggleOpen);
      });
      onBeforeUnmount(() => {
        host.removeEventListener("click", toggleOpen);
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("span", {
            class: "desktop-native-composer-model-label",
          }, h(NText, { strong: true }, { default: () => currentModel() })),
          open.value ? h("span", {
            class: "desktop-native-composer-model-menu",
            role: "listbox",
            "aria-label": "Model",
            onClick: (event: MouseEvent) => event.stopPropagation(),
          }, [
            h("span", { class: "desktop-native-composer-model-menu-title" }, "Model"),
            ...modelOptions().map((model) => h("span", {
              key: model,
              class: "desktop-native-composer-model-option",
              role: "option",
              "aria-selected": String(model === currentModel()),
              "data-desktop-composer-model-option": model,
              onClick: (event: MouseEvent) => selectModel(event, model),
            }, [
              h("span", { class: "desktop-native-composer-model-option-label" }, model),
              model === currentModel() ? renderModelCheckIcon() : null,
            ])),
          ]) : null,
        ],
      });
    },
  }));
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
