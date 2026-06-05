import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface KnowledgeReferenceRowIslandOptions {
  label: string;
  text: string;
  title: string;
}

export interface MountedKnowledgeReferenceRowIsland {
  unmount: () => void;
}

export function mountKnowledgeReferenceRowIsland(
  host: HTMLElement,
  options: KnowledgeReferenceRowIslandOptions,
): MountedKnowledgeReferenceRowIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-reference-row");
  const app = createKnowledgeReferenceRowApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeReferenceRowApp(options: KnowledgeReferenceRowIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeReferenceRowIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { tag: "span" }, {
          default: () => knowledgeReferenceRowText(options),
        }),
      });
    },
  }));
}

function knowledgeReferenceRowText(options: KnowledgeReferenceRowIslandOptions): string {
  return `${options.label}: ${options.title}${options.text ? ` - ${options.text}` : ""}`;
}
