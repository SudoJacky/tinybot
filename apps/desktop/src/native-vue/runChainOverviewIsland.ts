import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type RunChainOverviewIslandTab = "context" | "files" | "tasks";

export type RunChainOverviewIslandAction =
  | { type: "tab"; value: RunChainOverviewIslandTab; label: string }
  | { type: "summary"; value: "gateway" | "run" | "items"; label: string; tab: RunChainOverviewIslandTab }
  | { type: "pin"; value: boolean }
  | { type: "close" }
  | { type: "open-task-center" }
  | { type: "new-item" }
  | { type: "feed"; value: string; title: string };

export interface RunChainOverviewIslandOptions {
  items: DesktopRunChainItem[];
  onAction?: (action: RunChainOverviewIslandAction) => void;
}

export interface MountedRunChainOverviewIsland {
  unmount: () => void;
}

export function mountRunChainOverviewIsland(
  host: HTMLElement,
  options: RunChainOverviewIslandOptions,
): MountedRunChainOverviewIsland {
  host.setAttribute("data-desktop-vue-island", "run-chain-overview");
  host.className = "desktop-run-chain-overview";
  host.setAttribute("aria-label", "Run Chain");
  const app = createRunChainOverviewApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createRunChainOverviewApp(options: RunChainOverviewIslandOptions): App {
  return createApp(createRunChainOverviewComponent(options));
}

export function renderRunChainOverviewSurface(options: RunChainOverviewIslandOptions) {
  return h("section", {
    class: "desktop-run-chain-overview",
    "aria-label": "Run Chain",
  }, [
    h(createRunChainOverviewComponent(options)),
  ]);
}

function createRunChainOverviewComponent(options: RunChainOverviewIslandOptions) {
  return defineComponent({
    name: "RunChainOverviewIsland",
    setup() {
      const selectedTab = ref<RunChainOverviewIslandTab>("context");
      const pinned = ref(false);
      const selectTab = (tab: RunChainOverviewIslandTab): void => {
        selectedTab.value = tab;
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderHeader(pinned.value, (nextPinned) => {
            pinned.value = nextPinned;
            options.onAction?.({ type: "pin", value: nextPinned });
          }, options),
          renderSummaryStrip(options.items, (summary) => {
            selectTab(summary.tab);
            options.onAction?.({ type: "summary", value: summary.value, label: summary.label, tab: summary.tab });
          }),
          renderTabs(selectedTab.value, (tab, label) => {
            selectTab(tab);
            options.onAction?.({ type: "tab", value: tab, label });
          }),
          renderPanel(selectedTab.value, options),
          renderActions(options),
        ],
      });
    },
  });
}

function renderHeader(
  pinned: boolean,
  onPin: (nextPinned: boolean) => void,
  options: RunChainOverviewIslandOptions,
) {
  return h("header", { class: "desktop-run-chain-header" }, [
    h("h2", "Run Chain"),
    h(NSpace, {
      class: "desktop-run-chain-header-controls",
      size: 8,
    }, {
      default: () => [
        h(NButton, {
          class: "desktop-run-chain-icon-button",
          "aria-label": "Pin Run Chain",
          "aria-pressed": String(pinned),
          "data-desktop-run-chain-control": "pin",
          size: "tiny",
          secondary: true,
          onClick: () => onPin(!pinned),
        }, { default: () => (pinned ? "Pinned" : "Pin") }),
        h(NButton, {
          class: "desktop-run-chain-icon-button",
          "aria-label": "Close Run Chain",
          "data-desktop-run-chain-control": "close",
          size: "tiny",
          secondary: true,
          onClick: () => options.onAction?.({ type: "close" }),
        }, { default: () => "Close" }),
      ],
    }),
  ]);
}

function renderSummaryStrip(
  items: DesktopRunChainItem[],
  onSelect: (summary: {
    value: "gateway" | "run" | "items";
    label: string;
    tab: RunChainOverviewIslandTab;
  }) => void,
) {
  const status = runChainOverviewStatus(items);
  const summaries = [
    { value: "gateway", label: "Gateway", text: "Gateway: Connected", tab: "context" },
    { value: "run", label: "Run", text: `Run: ${status}`, tab: "tasks" },
    { value: "items", label: "Items", text: `${items.length} ${items.length === 1 ? "item" : "items"}`, tab: "tasks" },
  ] as const;
  return h(NSpace, {
    class: "desktop-run-chain-summary-strip",
    size: 8,
  }, {
    default: () => summaries.map((summary) => h(NButton, {
      class: "desktop-run-chain-summary-item",
      "data-desktop-run-chain-summary": summary.value,
      size: "tiny",
      secondary: true,
      onClick: () => onSelect(summary),
    }, { default: () => summary.text })),
  });
}

function renderTabs(
  selectedTab: RunChainOverviewIslandTab,
  onSelect: (tab: RunChainOverviewIslandTab, label: string) => void,
) {
  const tabs = [
    { id: "context", label: "Context" },
    { id: "files", label: "Files" },
    { id: "tasks", label: "Tasks" },
  ] as const;
  return h(NSpace, {
    class: "desktop-run-chain-tabs",
    role: "tablist",
    size: 8,
  }, {
    default: () => tabs.map((tab) => h(NButton, {
      class: "desktop-run-chain-tab",
      role: "tab",
      "aria-selected": String(tab.id === selectedTab),
      "data-desktop-run-chain-tab": tab.id,
      size: "small",
      type: tab.id === selectedTab ? "primary" : "default",
      secondary: tab.id !== selectedTab,
      onClick: () => onSelect(tab.id, tab.label),
    }, { default: () => tab.label })),
  });
}

function renderPanel(tab: RunChainOverviewIslandTab, options: RunChainOverviewIslandOptions) {
  return h("div", {
    class: "desktop-run-chain-panel desktop-run-chain-cards",
    "data-desktop-run-chain-panel": tab,
  }, renderPanelContent(tab, options));
}

function renderPanelContent(tab: RunChainOverviewIslandTab, options: RunChainOverviewIslandOptions) {
  if (tab === "files") {
    return [
      renderPanelSection("Workspace", [
        ["Project", "tinybot"],
        ["Path", "D:\\code\\tinybot\\tinybot"],
      ], h("a", {
        class: "desktop-run-chain-panel-action",
        href: "/workspace",
      }, "Open Workspace")),
    ];
  }

  if (tab === "tasks") {
    return [
      renderPanelSection("Current Run", [
        ["Status", runChainOverviewStatus(options.items)],
        ["Chain items", String(options.items.length)],
      ], renderNewItemButton(options, "desktop-run-chain-panel-action desktop-run-chain-new-item")),
      options.items.length ? renderActivityFeed(options.items, options) : null,
    ];
  }

  return [
    renderPanelSection("Gateway", [
      ["Status", "Connected"],
      ["Endpoint", "http://127.0.0.1:18790"],
      ["Mode", "External"],
      ["Version", "v0.1.0"],
    ], h("a", {
      class: "desktop-run-chain-panel-action",
      href: "/api/status",
    }, "Open Gateway Status")),
    renderPanelSection("Session Context", [
      ["Run", runChainOverviewStatus(options.items)],
      ["Items", String(options.items.length)],
    ]),
  ];
}

function renderPanelSection(
  title: string,
  rows: [string, string][],
  action?: ReturnType<typeof h>,
) {
  return h(NCard, {
    class: "desktop-run-chain-panel-section",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h3", title),
      ...rows.map(([label, value]) => h("p", {
        class: "desktop-run-chain-card-row",
      }, `${label}: ${value}`)),
      action ?? null,
    ],
  });
}

function renderActivityFeed(items: DesktopRunChainItem[], options: RunChainOverviewIslandOptions) {
  return h(NCard, {
    class: "desktop-run-chain-panel-section desktop-run-chain-activity-feed",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h3", "Activity"),
      ...items.slice(0, 4).map((item) => h(NButton, {
        class: "desktop-run-chain-feed-item",
        "data-desktop-run-chain-feed-item": item.key,
        size: "tiny",
        secondary: true,
        onClick: () => options.onAction?.({ type: "feed", value: item.key, title: item.title }),
      }, { default: () => `${item.title}: ${item.preview}` })),
    ],
  });
}

function renderActions(options: RunChainOverviewIslandOptions) {
  return h(NSpace, {
    class: "desktop-run-chain-actions",
    size: 8,
  }, {
    default: () => [
      h(NButton, {
        class: "desktop-run-chain-panel-action",
        "data-desktop-run-chain-action": "Open Task Center",
        size: "small",
        secondary: true,
        onClick: () => options.onAction?.({ type: "open-task-center" }),
      }, { default: () => "Open Task Center" }),
      renderNewItemButton(options, "desktop-run-chain-panel-action desktop-run-chain-new-item"),
    ],
  });
}

function renderNewItemButton(options: RunChainOverviewIslandOptions, className: string) {
  return h(NButton, {
    class: className,
    "data-desktop-run-chain-action": "New Run Chain Item",
    size: "small",
    secondary: true,
    onClick: () => options.onAction?.({ type: "new-item" }),
  }, { default: () => "New Run Chain Item" });
}

function runChainOverviewStatus(runChainItems: DesktopRunChainItem[]): string {
  if (runChainItems.some((item) => item.status === "failed")) {
    return "Needs attention";
  }
  if (runChainItems.some((item) => item.status === "running")) {
    return "Running";
  }
  return runChainItems.length ? "Completed" : "Idle";
}
