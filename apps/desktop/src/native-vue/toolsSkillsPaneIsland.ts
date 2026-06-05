import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NCard, NConfigProvider, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import type {
  DesktopSkillEditorField,
  DesktopSkillPaneDetailView,
  DesktopSkillRow,
  DesktopToolDetailView,
  DesktopToolRow,
  DesktopToolSchemaField,
  DesktopToolsSkillsPaneModel,
} from "../desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Tools and skills"),
          h("p", options.pane.status),
          renderToolsList(options.pane.toolRows),
          options.pane.selectedTool ? renderToolDetail(options.pane.selectedTool) : null,
          renderSkillsList(options.pane.skillRows),
          options.pane.selectedSkill ? renderSkillDetail(options, options.pane.selectedSkill) : null,
        ],
      });
    },
  }));
}

function renderToolsList(tools: DesktopToolRow[]) {
  return h("section", { class: "desktop-tools-list" }, [
    h("h2", "Tools"),
    tools.length
      ? h(NList, { bordered: false, hoverable: true }, {
        default: () => tools.map((tool) => h(NListItem, {
          "data-desktop-entity-module": "tools",
          "data-desktop-entity-id": tool.name,
        }, {
          default: () => h(NSpace, { vertical: true, size: 4 }, {
            default: () => [
              h("span", `${tool.displayName}: ${tool.meta}`),
              h(NSpace, { size: 4, wrap: true }, {
                default: () => [
                  h(NTag, { size: "small", round: true, type: tool.enabled ? "success" : "default" }, {
                    default: () => tool.enabled ? "enabled" : "disabled",
                  }),
                  tool.configHint ? h(NTag, { size: "small", round: true, type: "warning" }, { default: () => tool.configHint }) : null,
                ],
              }),
            ],
          }),
        })),
      })
      : h(NEmpty, { class: "desktop-tools-list-empty", description: "No tools loaded.", size: "small" }),
  ]);
}

function renderToolDetail(tool: DesktopToolDetailView) {
  return h("section", { class: "desktop-tool-detail" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", `Tool detail: ${tool.title}`),
        h("p", tool.description),
        h("p", `Config: ${tool.configHint || "ready"}`),
        renderToolSchemaFields(toolSchemaFields(tool)),
      ],
    }),
  ]);
}

function renderToolSchemaFields(fields: DesktopToolSchemaField[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => fields.map((field) => h(NListItem, {
      "data-desktop-tool-schema-field": field.name,
    }, {
      default: () => h(NSpace, { align: "center", size: 6, wrap: true }, {
        default: () => [
          h("span", toolFieldCopy(field)),
          field.required ? h(NTag, { size: "small", round: true, type: "warning" }, { default: () => "required" }) : null,
        ],
      }),
    })),
  });
}

function renderSkillsList(skills: DesktopSkillRow[]) {
  return h("section", { class: "desktop-skills-list" }, [
    h("h2", "Skills"),
    skills.length
      ? h(NList, { bordered: false, hoverable: true }, {
        default: () => skills.map((skill) => h(NListItem, {
          "data-desktop-entity-module": "skills",
          "data-desktop-entity-id": skill.name,
        }, {
          default: () => h(NSpace, { vertical: true, size: 4 }, {
            default: () => [
              h("span", `${skill.name}: ${skill.meta}`),
              h(NSpace, { size: 4, wrap: true }, {
                default: () => [
                  h(NTag, { size: "small", round: true, type: skillStatusType(skill.status) }, { default: () => skill.status }),
                  h(NTag, { size: "small", round: true }, { default: () => skill.source }),
                ],
              }),
            ],
          }),
        })),
      })
      : h(NEmpty, { class: "desktop-skills-list-empty", description: "No skills loaded.", size: "small" }),
  ]);
}

function renderSkillDetail(options: ToolsSkillsPaneIslandOptions, skill: DesktopSkillPaneDetailView) {
  return h("section", { class: "desktop-skill-detail" }, [
    renderSkillSummary(skill),
    renderSkillEditor(options, skill),
    renderSkillActions(options, skillActions(skill)),
  ]);
}

function renderSkillSummary(skill: DesktopSkillPaneDetailView) {
  return h("section", { class: "desktop-skill-detail-summary" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", `Skill detail: ${skill.name}`),
        h("p", skill.description),
        h("p", `Source: ${skill.source}`),
        h("p", `Always load: ${skill.always ? "Enabled" : "Disabled"}`),
        h("p", `Save state: ${skill.editor.saveMessage}`),
        h("p", `Validation: ${skill.editor.validation.message || skill.editor.validation.state}`),
      ],
    }),
  ]);
}

function renderSkillEditor(options: ToolsSkillsPaneIslandOptions, skill: DesktopSkillPaneDetailView) {
  return h("div", { class: "desktop-skill-editor" }, [
    renderSkillTextInput(options, "name", "Skill name", skill.editor.draft.name, !skill.nameEditable),
    renderSkillTextInput(options, "description", "Description", skill.editor.draft.description, false),
    renderSkillCheckbox(options, skill),
    h("textarea", {
      class: "desktop-skill-editor-field desktop-skill-editor-content",
      "aria-label": "Skill content",
      "data-desktop-skill-editor-field": "content",
      value: skill.editor.draft.content,
      onInput: (event: Event) => {
        emitSkillEdit(options, "content", String((event.target as HTMLTextAreaElement | null)?.value ?? ""));
      },
    }),
  ]);
}

function renderSkillTextInput(
  options: ToolsSkillsPaneIslandOptions,
  field: Extract<DesktopSkillEditorField, "name" | "description">,
  label: string,
  value: string,
  disabled: boolean,
) {
  return h("input", {
    class: "desktop-skill-editor-field",
    "aria-label": label,
    "data-desktop-skill-editor-field": field,
    disabled,
    value,
    onInput: (event: Event) => {
      emitSkillEdit(options, field, String((event.target as HTMLInputElement | null)?.value ?? ""));
    },
  });
}

function renderSkillCheckbox(options: ToolsSkillsPaneIslandOptions, skill: DesktopSkillPaneDetailView) {
  return h("input", {
    class: "desktop-skill-editor-field",
    type: "checkbox",
    "aria-label": "Always load",
    "data-desktop-skill-editor-field": "always",
    checked: skill.editor.draft.always,
    onChange: (event: Event) => {
      emitSkillEdit(options, "always", (event.target as HTMLInputElement | null)?.checked === true);
    },
  });
}

function renderSkillActions(options: ToolsSkillsPaneIslandOptions, actions: SkillActionItem[]) {
  return h("div", { class: "desktop-tools-skills-actions" }, [
    h(NSpace, { size: 8, wrap: true }, {
      default: () => actions.map((item) => h(NButton, {
        "data-desktop-tools-skills-action": item.action,
        disabled: !item.enabled,
        secondary: true,
        size: "small",
        type: actionButtonType(item.action),
        onClick: () => {
          if (item.enabled) {
            options.onToolsSkillsAction?.({ action: item.action, pane: options.pane });
          }
        },
      }, { default: () => item.label })),
    }),
  ]);
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

function toolSchemaFields(tool: DesktopToolDetailView): DesktopToolSchemaField[] {
  return tool.schemaFields.length
    ? tool.schemaFields
    : [{
      name: "parameters",
      type: "none",
      required: false,
      description: tool.emptySchemaText,
      defaultValue: "",
      enumValues: [],
    }];
}

function toolFieldCopy(field: DesktopToolSchemaField): string {
  return `${field.name}: ${field.type}${field.required ? " required" : ""}${field.description ? ` - ${field.description}` : ""}`;
}

function skillStatusType(status: DesktopSkillRow["status"]): "default" | "success" | "warning" {
  if (status === "always" || status === "enabled") {
    return "success";
  }
  if (status === "unavailable") {
    return "warning";
  }
  return "default";
}

function actionButtonType(action: SkillActionId): "default" | "error" | "primary" {
  if (action === "deleteSkill") {
    return "error";
  }
  if (action === "saveSkill" || action === "createSkill") {
    return "primary";
  }
  return "default";
}
