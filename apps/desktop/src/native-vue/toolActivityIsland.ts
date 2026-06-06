import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NTag, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ToolActivityIslandOptions {
  argsText: string;
  approvalStatus: string;
  id: string;
  kind: "call" | "result";
  name: string;
  responseText: string;
  runChainItemKey?: string;
}

export interface MountedToolActivityIsland {
  unmount: () => void;
}

export function mountToolActivityIsland(
  host: HTMLElement,
  options: ToolActivityIslandOptions,
): MountedToolActivityIsland {
  host.setAttribute("data-desktop-vue-island", "tool-activity");
  host.className = "desktop-tool-activity";
  host.setAttribute("data-desktop-tool-activity-kind", options.kind);
  if (options.id) {
    host.setAttribute("data-desktop-tool-activity-id", options.id);
  } else {
    host.removeAttribute("data-desktop-tool-activity-id");
  }
  if (options.runChainItemKey) {
    host.setAttribute("data-desktop-run-chain-item-key", options.runChainItemKey);
  } else {
    host.removeAttribute("data-desktop-run-chain-item-key");
  }
  const app = createToolActivityApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolActivityApp(options: ToolActivityIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolActivityIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderToolActivityChildren(options),
      });
    },
  }));
}

export function renderToolActivityNode(options: ToolActivityIslandOptions) {
  const attributes: Record<string, string> = {
    class: "desktop-tool-activity",
    "data-desktop-tool-activity-kind": options.kind,
  };
  if (options.id) {
    attributes["data-desktop-tool-activity-id"] = options.id;
  }
  if (options.runChainItemKey) {
    attributes["data-desktop-run-chain-item-key"] = options.runChainItemKey;
  }
  return h("details", attributes, renderToolActivityChildren(options));
}

export function renderToolActivityChildren(options: ToolActivityIslandOptions) {
  return [
    renderSummary(options),
    renderBody(options),
  ];
}

function renderSummary(options: ToolActivityIslandOptions) {
  return h("summary", {
    class: "desktop-tool-activity-summary",
    onClick: (event: MouseEvent) => dispatchRunChainInspect(event, options.runChainItemKey),
  }, [
    h("span", { "aria-hidden": "true", class: "desktop-tool-activity-icon" }, ">"),
    h("span", { class: "desktop-tool-activity-main" }, [
      h(NText, { class: "desktop-tool-activity-title", tag: "span" }, { default: () => options.name || "unknown" }),
      h(NText, { class: "desktop-tool-activity-preview", depth: 3, tag: "span" }, {
        default: () => summarizeToolActivityText(options.argsText || options.responseText),
      }),
    ]),
    h("span", { class: "desktop-tool-activity-badges" }, renderBadges(options)),
  ]);
}

function renderBadges(options: ToolActivityIslandOptions) {
  return [
    options.approvalStatus === "approved"
      ? h(NTag, {
        bordered: false,
        class: "desktop-tool-activity-badge desktop-tool-activity-approval-badge",
        round: true,
        size: "small",
        type: "success",
      }, { default: () => "Approved" })
      : null,
    h(NTag, {
      bordered: false,
      class: "desktop-tool-activity-badge",
      round: true,
      size: "small",
    }, { default: () => options.kind === "result" ? "Result" : "Call" }),
  ];
}

function renderBody(options: ToolActivityIslandOptions) {
  const children = [];
  if (options.argsText) {
    children.push(renderSection("Arguments", options.argsText, "call"));
  }
  if (options.responseText) {
    children.push(renderSection("Response", options.responseText, "response"));
  }
  if (!children.length) {
    children.push(h("div", { class: "desktop-tool-activity-empty" }, "No arguments or response."));
  }
  return h("div", { class: "desktop-tool-activity-body" }, children);
}

function renderSection(label: string, text: string, kind: "call" | "response") {
  if (shouldCollapseToolContent(text)) {
    return h("div", { class: `desktop-tool-activity-section desktop-tool-activity-section-${kind}` }, [
      h("details", { class: "desktop-tool-activity-content-details" }, [
        h("summary", { class: "desktop-tool-activity-content-summary" }, [
          h(NText, { class: "desktop-tool-activity-label", tag: "span" }, { default: () => label }),
          h("span", { class: "desktop-tool-activity-content-preview" }, summarizeToolActivityText(text)),
        ]),
        h("pre", { class: "desktop-tool-activity-pre" }, text),
      ]),
    ]);
  }
  return h("div", { class: `desktop-tool-activity-section desktop-tool-activity-section-${kind}` }, [
    h(NText, { class: "desktop-tool-activity-label", tag: "div" }, { default: () => label }),
    h("pre", { class: "desktop-tool-activity-pre" }, text),
  ]);
}

function summarizeToolActivityText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No details";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function shouldCollapseToolContent(value: string): boolean {
  return value.length > 140 || value.split(/\r?\n/).length > 6;
}

function dispatchRunChainInspect(event: MouseEvent, itemKey?: string): void {
  if (!itemKey) {
    return;
  }
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.dispatchEvent(new CustomEvent("desktop-run-chain-inspect", {
    bubbles: true,
    detail: { itemKey },
  }));
}
