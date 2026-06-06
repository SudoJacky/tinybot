import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type { DesktopSkillEditorField, DesktopSkillPaneDetailView } from "../desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SkillEditorIslandOptions {
  skill: DesktopSkillPaneDetailView;
  onEdit?: (field: DesktopSkillEditorField, value: string | boolean) => void;
}

export interface MountedSkillEditorIsland {
  unmount: () => void;
}

export function mountSkillEditorIsland(
  host: HTMLElement,
  options: SkillEditorIslandOptions,
): MountedSkillEditorIsland {
  host.setAttribute("data-desktop-vue-island", "skill-editor");
  host.className = "desktop-skill-editor";
  const app = createSkillEditorApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSkillEditorApp(options: SkillEditorIslandOptions): App {
  return createApp(defineComponent({
    name: "SkillEditorIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, { vertical: true, size: 8 }, {
          default: () => [
            renderInput(options, "name", "Skill name", options.skill.editor.draft.name, !options.skill.nameEditable),
            renderInput(options, "description", "Description", options.skill.editor.draft.description, false),
            renderCheckbox(options, "always", "Always load", options.skill.editor.draft.always),
            renderTextArea(options, "content", "Skill content", options.skill.editor.draft.content),
          ],
        }),
      });
    },
  }));
}

function renderInput(
  options: SkillEditorIslandOptions,
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
      options.onEdit?.(field, String((event.target as HTMLInputElement | null)?.value ?? ""));
    },
  });
}

function renderCheckbox(
  options: SkillEditorIslandOptions,
  field: Extract<DesktopSkillEditorField, "always">,
  label: string,
  checked: boolean,
) {
  return h("input", {
    class: "desktop-skill-editor-field",
    type: "checkbox",
    "aria-label": label,
    "data-desktop-skill-editor-field": field,
    checked,
    onChange: (event: Event) => {
      options.onEdit?.(field, (event.target as HTMLInputElement | null)?.checked === true);
    },
  });
}

function renderTextArea(
  options: SkillEditorIslandOptions,
  field: Extract<DesktopSkillEditorField, "content">,
  label: string,
  value: string,
) {
  return h("textarea", {
    class: "desktop-skill-editor-field desktop-skill-editor-content",
    "aria-label": label,
    "data-desktop-skill-editor-field": field,
    value,
    onInput: (event: Event) => {
      options.onEdit?.(field, String((event.target as HTMLTextAreaElement | null)?.value ?? ""));
    },
  });
}
