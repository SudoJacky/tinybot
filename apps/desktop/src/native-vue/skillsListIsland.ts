import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import type { DesktopSkillRow } from "../desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SkillsListIslandOptions {
  skills: DesktopSkillRow[];
}

export interface MountedSkillsListIsland {
  unmount: () => void;
}

export function mountSkillsListIsland(
  host: HTMLElement,
  options: SkillsListIslandOptions,
): MountedSkillsListIsland {
  host.setAttribute("data-desktop-vue-island", "skills-list");
  host.className = "desktop-skills-list";
  const app = createSkillsListApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSkillsListApp(options: SkillsListIslandOptions): App {
  return createApp(defineComponent({
    name: "SkillsListIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Skills"),
          options.skills.length
            ? renderSkills(options.skills)
            : h(NEmpty, {
              class: "desktop-skills-list-empty",
              description: "No skills loaded.",
              size: "small",
            }),
        ],
      });
    },
  }));
}

function renderSkills(skills: DesktopSkillRow[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => skills.map((skill) => h(NListItem, {
      "data-desktop-entity-module": "skills",
      "data-desktop-entity-id": skill.name,
    }, {
      default: () => h(NSpace, { vertical: true, size: 4 }, {
        default: () => [
          h("span", `${skill.name}: ${skill.meta}`),
          h(NSpace, { size: 4, wrap: true }, {
            default: () => [
              h(NTag, { size: "small", round: true, type: statusType(skill.status) }, { default: () => skill.status }),
              h(NTag, { size: "small", round: true }, { default: () => skill.source }),
            ],
          }),
        ],
      }),
    })),
  });
}

function statusType(status: DesktopSkillRow["status"]): "default" | "success" | "warning" {
  if (status === "always" || status === "enabled") {
    return "success";
  }
  if (status === "unavailable") {
    return "warning";
  }
  return "default";
}
