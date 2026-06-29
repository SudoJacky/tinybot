import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type RunChainOverviewIslandTab = "context" | "files" | "tasks" | "approvals" | "activity";

export type RunChainOverviewIslandAction =
  | { type: "tab"; value: RunChainOverviewIslandTab; label: string }
  | { type: "summary"; value: "gateway" | "run" | "items" | "approvals"; label: string; tab: RunChainOverviewIslandTab }
  | { type: "pin"; value: boolean }
  | { type: "close" }
  | { type: "open-task-center" }
  | { type: "new-item" }
  | { type: "feed"; value: string; title: string };

export interface RunChainOverviewIslandOptions {
  items: DesktopRunChainItem[];
  taskItems?: DesktopTaskCenterItem[];
  initialTab?: RunChainOverviewIslandTab;
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
  host.setAttribute("aria-label", "Activity inspector");
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
    "aria-label": "Activity inspector",
  }, [
    h(createRunChainOverviewComponent(options)),
  ]);
}

function createRunChainOverviewComponent(options: RunChainOverviewIslandOptions) {
  return defineComponent({
    name: "RunChainOverviewIsland",
    setup() {
      const selectedTab = ref<RunChainOverviewIslandTab>(options.initialTab ?? "context");
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
          renderSummaryStrip(options.items, pendingApprovalItems(options.taskItems ?? []), (summary) => {
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
    h("h2", "Activity"),
    h(NSpace, {
      class: "desktop-run-chain-header-controls",
      size: 8,
    }, {
      default: () => [
        h(NButton, {
          class: "desktop-run-chain-icon-button",
          "aria-label": "Pin panel",
          "aria-pressed": String(pinned),
          "data-desktop-run-chain-control": "pin",
          "data-button-variant": "ghost",
          size: "tiny",
          secondary: true,
          title: "Pin panel",
          onClick: () => onPin(!pinned),
        }, { default: () => (pinned ? "Pinned" : "Pin") }),
        h(NButton, {
          class: "desktop-run-chain-icon-button",
          "aria-label": "Close panel",
          "data-desktop-run-chain-control": "close",
          "data-button-variant": "ghost",
          size: "tiny",
          secondary: true,
          title: "Close panel",
          onClick: () => options.onAction?.({ type: "close" }),
        }, { default: () => "Close" }),
      ],
    }),
  ]);
}

function renderSummaryStrip(
  items: DesktopRunChainItem[],
  approvalItems: DesktopTaskCenterItem[],
  onSelect: (summary: {
    value: "gateway" | "run" | "items" | "approvals";
    label: string;
    tab: RunChainOverviewIslandTab;
  }) => void,
) {
  const status = runChainOverviewStatus(items);
  const approvalCount = approvalItems.length;
  const summaries = [
    { value: "gateway", label: "Gateway", text: "Gateway", accessibleText: "Gateway: Connected", tab: "context", tone: "connected" },
    { value: "run", label: "Run", text: status, accessibleText: `Run: ${status}`, tab: "activity", tone: "muted" },
    { value: "items", label: "Items", text: `${items.length} ${items.length === 1 ? "item" : "items"}`, accessibleText: `Items: ${items.length}`, tab: "activity", tone: "muted" },
    { value: "approvals", label: "Approvals", text: `${approvalCount} ${approvalCount === 1 ? "approval" : "approvals"}`, accessibleText: `Approvals: ${approvalCount}`, tab: "approvals", tone: approvalCount ? "attention" : "muted" },
  ] as const;
  return h(NSpace, {
    class: "desktop-run-chain-summary-strip",
    size: 8,
  }, {
    default: () => summaries.map((summary) => h(NButton, {
      class: "desktop-run-chain-summary-item desktop-run-chain-status-pill",
      "data-desktop-run-chain-summary": summary.value,
      "data-status-tone": summary.tone,
      "aria-label": summary.accessibleText,
      title: summary.accessibleText,
      size: "tiny",
      secondary: true,
      onClick: () => onSelect(summary),
    }, {
      default: () => [
        summary.tone === "connected"
          ? h("span", { class: "desktop-run-chain-status-dot", "aria-hidden": "true" })
          : null,
        h("span", summary.text),
      ],
    })),
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
    { id: "approvals", label: "Approvals" },
    { id: "activity", label: "Activity" },
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
      renderPanelSection("Files", [
        ["Project", "tinybot"],
        ["Path", "D:\\code\\tinybot\\tinybot"],
      ], h("a", {
        class: "desktop-run-chain-panel-action",
        href: "/files",
      }, "Open Files")),
    ];
  }

  if (tab === "tasks") {
    return [
      renderPanelSection("Tasks", [
        ["Task center", "Available"],
        ["Run", runChainOverviewStatus(options.items)],
        ["Chain items", String(options.items.length)],
      ], renderNewItemButton(options, "desktop-run-chain-panel-action desktop-run-chain-new-item", "secondary"), options.items.length ? undefined : "No chain items yet."),
    ];
  }

  if (tab === "approvals") {
    const approvalItems = pendingApprovalItems(options.taskItems ?? []);
    return [
      renderPanelSection("Approvals", [
        ["Pending", String(approvalItems.length)],
        ["Policy", "Ask before sensitive actions"],
        ["Queue", approvalItems.length ? `${approvalItems.length} pending ${approvalItems.length === 1 ? "approval" : "approvals"}` : "No pending approvals"],
      ], h(NButton, {
        class: "desktop-run-chain-panel-action",
        "data-desktop-run-chain-action": "Open Task Center",
        "data-button-variant": "secondary",
        size: "small",
        secondary: true,
        onClick: () => options.onAction?.({ type: "open-task-center" }),
      }, { default: () => "Open Task Center" }), approvalItems.length ? undefined : "No pending approvals"),
      approvalItems.length ? renderApprovalQueue(approvalItems, options) : null,
    ];
  }

  if (tab === "activity") {
    return [
      renderPanelSection("Activity Feed", [
        ["Status", runChainOverviewStatus(options.items)],
        ["Events", String(options.items.length)],
      ], undefined, options.items.length ? undefined : "Gateway events, tool calls, and runtime logs appear here."),
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
  emptyState?: string,
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
      emptyState ? h("p", { class: "desktop-run-chain-empty-state" }, emptyState) : null,
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

function renderApprovalQueue(items: DesktopTaskCenterItem[], options: RunChainOverviewIslandOptions) {
  return h(NCard, {
    class: "desktop-run-chain-panel-section desktop-run-chain-approval-list",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h3", "Approval Queue"),
      ...items.slice(0, 4).map((item) => h(NButton, {
        class: "desktop-run-chain-approval-item",
        "data-desktop-run-chain-approval-item": item.id,
        "data-status-tone": item.tone,
        size: "tiny",
        secondary: true,
        onClick: () => options.onAction?.({ type: "open-task-center" }),
      }, {
        default: () => [
          h("span", { class: "desktop-run-chain-approval-title" }, item.title),
          item.detail ? h("span", { class: "desktop-run-chain-approval-detail" }, item.detail) : null,
        ],
      })),
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
        "data-button-variant": "primary",
        size: "small",
        type: "primary",
        onClick: () => options.onAction?.({ type: "open-task-center" }),
      }, { default: () => "Open Task Center" }),
    ],
  });
}

function renderNewItemButton(
  options: RunChainOverviewIslandOptions,
  className: string,
  variant = "secondary",
) {
  return h(NButton, {
    class: className,
    "data-desktop-run-chain-action": "New Activity Item",
    "data-button-variant": variant,
    size: "small",
    secondary: true,
    onClick: () => options.onAction?.({ type: "new-item" }),
  }, { default: () => "New Activity Item" });
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

function pendingApprovalItems(items: DesktopTaskCenterItem[]): DesktopTaskCenterItem[] {
  return items.filter((item) => item.source === "approval" && item.state !== "completed" && item.state !== "canceled");
}
