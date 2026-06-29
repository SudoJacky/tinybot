import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopCoworkCockpitView } from "../desktopCowork";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

type CoworkHeader = DesktopCoworkCockpitView["header"];

export interface CoworkHeaderIslandOptions {
  header: CoworkHeader;
}

export interface MountedCoworkHeaderIsland {
  unmount: () => void;
}

export function mountCoworkHeaderIsland(
  host: HTMLElement,
  options: CoworkHeaderIslandOptions,
): MountedCoworkHeaderIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-header");
  host.className = "desktop-cowork-header";
  const app = createCoworkHeaderApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkHeaderApp(options: CoworkHeaderIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkHeaderIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", options.header.title),
            h("p", options.header.goal || "No goal provided."),
            h("p", headerMeta(options.header)),
            h(NSpace, { size: 6 }, {
              default: () => [
                h(NTag, { size: "small", round: true }, { default: () => options.header.status }),
                h(NTag, { size: "small", round: true }, { default: () => options.header.workflow }),
              ],
            }),
          ],
        }),
      });
    },
  }));
}

function headerMeta(header: CoworkHeader): string {
  return `${header.status} / ${header.workflow}${header.updatedAt ? ` / ${header.updatedAt}` : ""}`;
}
