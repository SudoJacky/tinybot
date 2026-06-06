import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NList, NListItem, NSpace, NTag } from "naive-ui";
import type { DesktopToolDetailView, DesktopToolSchemaField } from "../desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ToolDetailIslandOptions {
  tool: DesktopToolDetailView;
}

export interface MountedToolDetailIsland {
  unmount: () => void;
}

export function mountToolDetailIsland(
  host: HTMLElement,
  options: ToolDetailIslandOptions,
): MountedToolDetailIsland {
  host.setAttribute("data-desktop-vue-island", "tool-detail");
  host.className = "desktop-tool-detail";
  const app = createToolDetailApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolDetailApp(options: ToolDetailIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolDetailIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", `Tool detail: ${options.tool.title}`),
            h("p", options.tool.description),
            h("p", `Config: ${options.tool.configHint || "ready"}`),
            renderFields(toolSchemaFields(options.tool)),
          ],
        }),
      });
    },
  }));
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

function renderFields(fields: DesktopToolSchemaField[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => fields.map((field) => h(NListItem, {
      "data-desktop-tool-schema-field": field.name,
    }, {
      default: () => h(NSpace, { align: "center", size: 6, wrap: true }, {
        default: () => [
          h("span", fieldCopy(field)),
          field.required ? h(NTag, { size: "small", round: true, type: "warning" }, { default: () => "required" }) : null,
        ],
      }),
    })),
  });
}

function fieldCopy(field: DesktopToolSchemaField): string {
  return `${field.name}: ${field.type}${field.required ? " required" : ""}${field.description ? ` - ${field.description}` : ""}`;
}
