import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type {
  DesktopSkillEditorField,
  DesktopSkillPaneDetailView,
  DesktopToolsSkillsPaneModel,
} from "../../tools-skills/desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";
import { mountSkillDetailSummaryIsland } from "./skillDetailSummaryIsland";
import { mountSkillEditorIsland } from "./skillEditorIsland";
import { mountSkillsListIsland } from "./skillsListIsland";
import { mountToolDetailIsland } from "./toolDetailIsland";
import { mountToolsListIsland } from "./toolsListIsland";
import { mountToolsSkillsActionsIsland } from "./toolsSkillsActionsIsland";

export type ToolsSkillsPaneActionId = "createSkill" | "editSkill" | "saveSkill" | "deleteSkill" | "validateSkill" | "toggleAlways";

export interface ToolsSkillsPaneActionEvent {
  action: ToolsSkillsPaneActionId;
  pane: DesktopToolsSkillsPaneModel;
  field?: DesktopSkillEditorField;
  value?: string | boolean;
}

export interface ToolsSkillsPaneIslandOptions {
  pane: DesktopToolsSkillsPaneModel;
  onToolsSkillsAction?: (event: ToolsSkillsPaneActionEvent) => void;
}

export interface MountedToolsSkillsPaneIsland {
  unmount: () => void;
}

type SkillActionId = Exclude<ToolsSkillsPaneActionId, "editSkill">;

interface SkillActionItem {
  action: SkillActionId;
  label: string;
  enabled: boolean;
}

export function mountToolsSkillsPaneIsland(
  host: HTMLElement,
  options: ToolsSkillsPaneIslandOptions,
): MountedToolsSkillsPaneIsland {
  host.setAttribute("data-desktop-vue-island", "tools-skills-pane");
  host.className = "desktop-workbench-section desktop-tools-skills-pane";
  host.setAttribute("data-desktop-module-surface", "tools skills");
  host.setAttribute("aria-label", "Tools and skills");

  const app = createToolsSkillsPaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolsSkillsPaneApp(options: ToolsSkillsPaneIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolsSkillsPaneIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const toolsList = ref<HTMLElement | null>(null);
      const toolDetail = ref<HTMLElement | null>(null);
      const skillsList = ref<HTMLElement | null>(null);
      const skillSummary = ref<HTMLElement | null>(null);
      const skillEditor = ref<HTMLElement | null>(null);
      const skillActionsHost = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, toolsList.value, (host) => mountToolsListIsland(host, { tools: options.pane.toolRows }));
        if (options.pane.selectedTool) {
          mountChild(mountedChildren, toolDetail.value, (host) => mountToolDetailIsland(host, { tool: options.pane.selectedTool! }));
        }
        mountChild(mountedChildren, skillsList.value, (host) => mountSkillsListIsland(host, { skills: options.pane.skillRows }));
        if (options.pane.selectedSkill) {
          mountChild(mountedChildren, skillSummary.value, (host) => mountSkillDetailSummaryIsland(host, { skill: options.pane.selectedSkill! }));
          mountChild(mountedChildren, skillEditor.value, (host) => mountSkillEditorIsland(host, {
            skill: options.pane.selectedSkill!,
            onEdit: (field, value) => emitSkillEdit(options, field, value),
          }));
          mountChild(mountedChildren, skillActionsHost.value, (host) => mountToolsSkillsActionsIsland(host, {
            actions: skillActions(options.pane.selectedSkill!),
            onAction: (action) => options.onToolsSkillsAction?.({ action, pane: options.pane }),
          }));
        }
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          class: "desktop-tools-skills-stack",
          vertical: true,
          size: 12,
        }, {
          default: () => [
            h("h2", "Tools and skills"),
            h("p", options.pane.status),
            h("section", { ref: toolsList }),
            options.pane.selectedTool ? h("section", { ref: toolDetail }) : null,
            h("section", { ref: skillsList }),
            options.pane.selectedSkill
              ? h("section", { class: "desktop-skill-detail" }, [
                h("section", { ref: skillSummary }),
                h("div", { ref: skillEditor }),
                h("div", { ref: skillActionsHost }),
              ])
              : null,
          ],
        }),
      });
    },
  }));
}

function emitSkillEdit(
  options: ToolsSkillsPaneIslandOptions,
  field: DesktopSkillEditorField,
  value: string | boolean,
): void {
  options.onToolsSkillsAction?.({
    action: "editSkill",
    pane: options.pane,
    field,
    value,
  });
}

function skillActions(skill: DesktopSkillPaneDetailView): SkillActionItem[] {
  return [
    { action: "createSkill", label: "Create skill", enabled: skill.actions.create },
    { action: "saveSkill", label: "Save skill", enabled: skill.actions.save },
    { action: "validateSkill", label: "Validate skill", enabled: skill.actions.validate },
    { action: "deleteSkill", label: "Delete skill", enabled: skill.actions.delete },
    { action: "toggleAlways", label: "Toggle always-load", enabled: skill.actions.toggleAlways },
  ];
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
