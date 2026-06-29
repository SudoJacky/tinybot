import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopSkillPaneDetailView } from "../../tools-skills/desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface SkillDetailSummaryIslandOptions {
  skill: DesktopSkillPaneDetailView;
}

export interface MountedSkillDetailSummaryIsland {
  unmount: () => void;
}

export function mountSkillDetailSummaryIsland(
  host: HTMLElement,
  options: SkillDetailSummaryIslandOptions,
): MountedSkillDetailSummaryIsland {
  host.setAttribute("data-desktop-vue-island", "skill-detail-summary");
  host.className = "desktop-skill-detail-summary";
  const app = createSkillDetailSummaryApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSkillDetailSummaryApp(options: SkillDetailSummaryIslandOptions): App {
  return createApp(defineComponent({
    name: "SkillDetailSummaryIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", `Skill detail: ${options.skill.name}`),
            h("p", options.skill.description),
            h("p", `Source: ${options.skill.source}`),
            h("p", `Always load: ${options.skill.always ? "Enabled" : "Disabled"}`),
            h("p", `Save state: ${options.skill.editor.saveMessage}`),
            h("p", `Validation: ${validationCopy(options.skill)}`),
            h(NSpace, { size: 4, wrap: true }, {
              default: () => [
                h(NTag, { size: "small", round: true }, { default: () => options.skill.source }),
                h(NTag, { size: "small", round: true, type: options.skill.always ? "success" : "default" }, {
                  default: () => options.skill.always ? "always" : "manual",
                }),
                h(NTag, { size: "small", round: true, type: validationType(options.skill) }, {
                  default: () => validationCopy(options.skill),
                }),
              ],
            }),
          ],
        }),
      });
    },
  }));
}

function validationCopy(skill: DesktopSkillPaneDetailView): string {
  return skill.editor.validation.message || skill.editor.validation.state;
}

function validationType(skill: DesktopSkillPaneDetailView): "default" | "error" | "success" {
  if (skill.editor.validation.state === "valid") {
    return "success";
  }
  if (skill.editor.validation.state === "invalid") {
    return "error";
  }
  return "default";
}
