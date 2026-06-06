import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NButton, NConfigProvider, NText } from "naive-ui";
import {
  createDesktopRunChainInspectorView,
  type DesktopInspectorView,
  type DesktopRunChainItem,
} from "../desktopRunChainInspector";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface RunChainInspectorIslandOptions {
  eventTarget?: Pick<Document, "addEventListener" | "removeEventListener"> | null;
  items: DesktopRunChainItem[];
  selectedItemKey?: string | null;
  onSelect?: (item: DesktopRunChainItem) => void;
}

export interface MountedRunChainInspectorIsland {
  unmount: () => void;
}

export function mountRunChainInspectorIsland(
  host: HTMLElement,
  options: RunChainInspectorIslandOptions,
): MountedRunChainInspectorIsland {
  applyHostContract(host);
  const app = createRunChainInspectorApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyHostContract(host: HTMLElement): void {
  host.setAttribute("data-desktop-vue-island", "run-chain-inspector");
  host.className = "desktop-workbench-section desktop-run-chain-inspector";
  host.setAttribute("aria-label", "Run-chain inspector");
}

function createRunChainInspectorApp(options: RunChainInspectorIslandOptions): App {
  return createApp(createRunChainInspectorComponent(options));
}

export function renderRunChainInspectorSurface(options: RunChainInspectorIslandOptions) {
  return h("section", {
    class: "desktop-workbench-section desktop-run-chain-inspector",
    "aria-label": "Run-chain inspector",
  }, [
    h(createRunChainInspectorComponent(options)),
  ]);
}

function createRunChainInspectorComponent(options: RunChainInspectorIslandOptions) {
  return defineComponent({
    name: "RunChainInspectorIsland",
    setup() {
      const selectedKey = ref(resolveSelectedItem(options)?.key ?? "");
      const selectItem = (item: DesktopRunChainItem): void => {
        selectedKey.value = item.key;
        options.onSelect?.(item);
      };
      const inspectItem = (event: Event): void => {
        const itemKey = (event as CustomEvent<{ itemKey?: string }>).detail?.itemKey;
        const item = options.items.find((candidate) => candidate.key === itemKey);
        if (item) {
          selectItem(item);
        }
      };
      onMounted(() => {
        const target = options.eventTarget ?? (typeof document !== "undefined" ? document : null);
        target?.addEventListener("desktop-run-chain-inspect", inspectItem as EventListener);
      });
      onBeforeUnmount(() => {
        const target = options.eventTarget ?? (typeof document !== "undefined" ? document : null);
        target?.removeEventListener("desktop-run-chain-inspect", inspectItem as EventListener);
      });

      return () => {
        const selectedItem = options.items.find((item) => item.key === selectedKey.value) ?? resolveSelectedItem(options);
        return h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
          default: () => [
            h("h2", "Run-chain inspector"),
            h(NText, { depth: 3, tag: "p" }, { default: () => buildRunChainSummary(options.items) }),
            renderItemList(options.items, selectedItem?.key ?? "", selectItem),
            h("section", { class: "desktop-run-chain-detail" }, selectedItem ? renderInspectorView(createDesktopRunChainInspectorView(selectedItem)) : []),
          ],
        });
      };
    },
  });
}

function resolveSelectedItem(options: RunChainInspectorIslandOptions): DesktopRunChainItem | null {
  return options.items.find((item) => item.key === options.selectedItemKey && item.inspectable)
    ?? options.items.find((item) => item.inspectable)
    ?? options.items[0]
    ?? null;
}

function renderItemList(
  items: DesktopRunChainItem[],
  selectedKey: string,
  onSelect: (item: DesktopRunChainItem) => void,
) {
  return h("div", {
    class: "desktop-run-chain-list",
    role: "listbox",
    "aria-label": "Run-chain items",
  }, items.map((item) => h(NButton, {
    class: "desktop-run-chain-item",
    role: "option",
    "data-desktop-run-chain-item": item.key,
    "data-desktop-run-chain-kind": item.kind,
    "aria-selected": String(item.key === selectedKey),
    size: "small",
    secondary: item.key !== selectedKey,
    type: item.key === selectedKey ? "primary" : "default",
    onClick: () => onSelect(item),
  }, { default: () => `${item.title}: ${item.preview}` })));
}

function renderInspectorView(view: DesktopInspectorView) {
  const rows = inspectorViewRows(view);
  return h("section", {
    class: "desktop-workbench-section desktop-inspector-view",
    "data-desktop-inspector-view": "",
  }, [
    h("h2", view.title),
    view.subtitle ? h(NText, { depth: 3, tag: "p" }, { default: () => view.subtitle }) : null,
    rows.length
      ? rows.map((row) => h(NText, {
        class: "desktop-inspector-view-row",
        depth: 2,
        tag: "p",
      }, { default: () => row }))
      : h(NText, {
        class: "desktop-inspector-view-empty",
        depth: 3,
        tag: "p",
      }, { default: () => view.emptyText }),
  ]);
}

function inspectorViewRows(view: DesktopInspectorView): string[] {
  return view.sections.map((item) => {
    if (item.type === "browserActivity") {
      return `${item.activity.actionLabel}: ${[item.activity.title, item.activity.url].filter(Boolean).join(" | ")}`;
    }
    return `${item.label}: ${item.text}`;
  });
}

function buildRunChainSummary(items: DesktopRunChainItem[]): string {
  if (!items.length) {
    return "No run-chain items available.";
  }
  const running = items.filter((item) => item.status === "running").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const completed = items.filter((item) => item.status === "completed").length;
  return `${items.length} items - ${running} running - ${completed} completed - ${failed} failed`;
}
