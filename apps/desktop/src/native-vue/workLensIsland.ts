import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type {
  DesktopWorkLensActionId,
  DesktopWorkLensNextAction,
  DesktopWorkLensProjection,
  DesktopWorkLensRelatedResource,
  DesktopWorkLensSection,
} from "../desktopWorkLens";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface WorkLensIslandActionEvent {
  action: DesktopWorkLensActionId;
  workLens: DesktopWorkLensProjection;
}

export interface WorkLensIslandOptions {
  workLens: DesktopWorkLensProjection;
  placement?: "inspector" | "inline";
  onAction?: (event: WorkLensIslandActionEvent) => void;
  copyText?: (text: string) => void | Promise<void>;
}

export interface MountedWorkLensIsland {
  unmount: () => void;
}

export function mountWorkLensIsland(host: HTMLElement, options: WorkLensIslandOptions): MountedWorkLensIsland {
  const placement = options.placement ?? "inspector";
  host.setAttribute("data-desktop-vue-island", "work-lens");
  host.className = "desktop-workbench-section desktop-work-lens";
  host.setAttribute("aria-label", "Work Lens");
  host.setAttribute("data-desktop-work-lens-mode", options.workLens.mode);
  host.setAttribute("data-desktop-work-lens-kind", options.workLens.kind);
  host.setAttribute("data-desktop-work-lens-id", options.workLens.id);
  host.setAttribute("data-desktop-work-lens-placement", placement);
  if (options.workLens.fallbackReason) {
    host.setAttribute("data-desktop-work-lens-fallback-reason", options.workLens.fallbackReason);
  } else {
    host.removeAttribute("data-desktop-work-lens-fallback-reason");
  }

  const app = createWorkLensApp(options, placement);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkLensApp(options: WorkLensIslandOptions, placement: "inspector" | "inline"): App {
  return createApp(defineComponent({
    name: "WorkLensIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderHeader(options.workLens, placement),
          options.workLens.fallbackReason ? renderFallback(options.workLens.fallbackReason) : null,
          ...options.workLens.sections.map(renderWorkLensSection),
          options.workLens.relatedResources.length
            ? renderResourceList("Related resources", options.workLens.relatedResources)
            : null,
          options.workLens.outputs.length
            ? renderResourceList("Outputs", options.workLens.outputs)
            : null,
          options.workLens.nextActions.length
            ? renderActions(options.workLens, options)
            : null,
        ],
      });
    },
  }));
}

function renderHeader(workLens: DesktopWorkLensProjection, placement: "inspector" | "inline") {
  return h("header", { class: "desktop-work-lens-header" }, [
    h("h2", "Work Lens"),
    h(NSpace, { size: 6, align: "center" }, {
      default: () => [
        h(NTag, { size: "small", round: true, type: workLens.mode === "ready" ? "success" : "warning" }, {
          default: () => workLens.mode,
        }),
        h(NTag, { size: "small", round: true }, { default: () => placement }),
      ],
    }),
    h("p", workLens.title),
  ]);
}

function renderFallback(fallbackReason: string) {
  return h("p", {
    "data-desktop-work-lens-fallback": fallbackReason,
    "aria-label": `Work Lens fallback: ${fallbackReason}`,
  }, fallbackReason);
}

function renderWorkLensSection(section: DesktopWorkLensSection) {
  return h(NCard, {
    class: "desktop-work-lens-section",
    "data-desktop-work-lens-section": section.id,
    "aria-label": `Work Lens section: ${section.id}`,
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h2", section.title),
      ...section.rows.map((row) => h("p", `${row.label}: ${row.value}`)),
    ],
  });
}

function renderResourceList(title: string, resources: DesktopWorkLensRelatedResource[]) {
  return h(NCard, {
    class: "desktop-work-lens-resources",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h2", title),
      h(NSpace, { vertical: true, size: 6 }, {
        default: () => resources.map(renderResource),
      }),
    ],
  });
}

function renderResource(resource: DesktopWorkLensRelatedResource) {
  const label = `${resource.title}: ${resource.detail}`.replace(/: $/, "");
  const commonProps = {
    class: "desktop-work-lens-resource",
    "data-desktop-work-lens-resource": resource.id,
    "data-desktop-work-lens-resource-kind": resource.kind,
    "aria-label": `Work Lens resource: ${resource.kind} ${resource.title}`,
  };
  if (resource.route.href) {
    return h("a", {
      ...commonProps,
      href: resource.route.href,
    }, label);
  }
  return h(NButton, {
    ...commonProps,
    size: "tiny",
    secondary: true,
  }, { default: () => label });
}

function renderActions(workLens: DesktopWorkLensProjection, options: WorkLensIslandOptions) {
  return h(NSpace, {
    class: "desktop-work-lens-actions",
    "aria-label": `${workLens.title} next actions`,
    size: 8,
  }, {
    default: () => workLens.nextActions.map((action) => renderAction(action, workLens, options)),
  });
}

function renderAction(
  action: DesktopWorkLensNextAction,
  workLens: DesktopWorkLensProjection,
  options: WorkLensIslandOptions,
) {
  const commonProps = {
    class: "desktop-work-lens-action",
    "data-desktop-work-lens-action": action.id,
    "aria-label": `Work Lens action: ${action.id} ${workLens.title}`,
  };
  if (action.route?.href) {
    return h("a", {
      ...commonProps,
      href: action.route.href,
    }, action.label);
  }
  return h(NButton, {
    ...commonProps,
    size: "small",
    secondary: true,
    type: action.id === "copyDiagnostics" ? "primary" : "default",
    onClick: (event: Event) => {
      event.preventDefault();
      options.onAction?.({ action: action.id, workLens });
      if (action.id === "copyDiagnostics" && action.diagnosticText) {
        void options.copyText?.(action.diagnosticText);
      }
    },
  }, { default: () => action.label });
}
