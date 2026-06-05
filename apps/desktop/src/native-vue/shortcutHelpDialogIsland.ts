import { computed, createApp, defineComponent, h, onMounted, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ShortcutHelpItem {
  command: string;
  description: string;
  key: string;
}

export interface ShortcutHelpGroup {
  title: string;
  items: ShortcutHelpItem[];
}

export interface ShortcutHelpDialogIslandOptions {
  groups: ShortcutHelpGroup[];
}

export interface MountedShortcutHelpDialogIsland {
  unmount: () => void;
}

export function mountShortcutHelpDialogIsland(
  host: HTMLElement,
  options: ShortcutHelpDialogIslandOptions,
): MountedShortcutHelpDialogIsland {
  host.id = "desktop-shortcut-help-dialog";
  host.className = "desktop-shortcut-help-dialog";
  host.setAttribute("data-desktop-vue-island", "shortcut-help-dialog");
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Keyboard shortcuts");
  const app = createShortcutHelpDialogApp(host, options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createShortcutHelpDialogApp(host: HTMLElement, options: ShortcutHelpDialogIslandOptions): App {
  return createApp(defineComponent({
    name: "ShortcutHelpDialogIsland",
    setup() {
      const query = ref("");
      const search = ref<HTMLInputElement | null>(null);
      const visibleGroups = computed(() => filterShortcutGroups(options.groups, query.value));

      onMounted(() => {
        search.value?.focus();
      });

      const close = () => {
        host.hidden = true;
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", {
          class: "desktop-shortcut-help-panel",
          onKeydown: (event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          },
        }, [
          h("header", { class: "desktop-shortcut-help-header" }, [
            h("h2", "Keyboard shortcuts"),
            h(NButton, {
              class: "desktop-shortcut-help-close",
              "aria-label": "Close keyboard shortcuts",
              quaternary: true,
              size: "small",
              onClick: close,
            }, { default: () => "x" }),
          ]),
          h("input", {
            ref: search,
            class: "desktop-shortcut-help-search",
            placeholder: "Search shortcuts",
            type: "search",
            value: query.value,
            "aria-label": "Search shortcuts",
            onInput: (event: Event) => {
              query.value = String((event.target as HTMLInputElement | null)?.value ?? "");
            },
          }),
          h("div", {
            class: "desktop-shortcut-help-list",
            role: "list",
          }, visibleGroups.value.map((group) => renderShortcutGroup(group))),
        ]),
      });
    },
  }));
}

function filterShortcutGroups(groups: ShortcutHelpGroup[], query: string): ShortcutHelpGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return groups;
  }
  return groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter((item) => `${item.command} ${item.key} ${item.description}`.toLowerCase().includes(normalizedQuery)),
    }))
    .filter((group) => group.items.length);
}

function renderShortcutGroup(group: ShortcutHelpGroup) {
  return h(NCard, {
    class: "desktop-shortcut-help-group",
    bordered: false,
    embedded: true,
    size: "small",
  }, {
    default: () => [
      h("h3", group.title),
      h(NSpace, { vertical: true, size: 6 }, {
        default: () => group.items.map((item) => h("div", {
          class: "desktop-shortcut-help-row",
          role: "listitem",
        }, [
          h("span", { class: "desktop-shortcut-help-command" }, item.command),
          h("kbd", { class: "desktop-shortcut-help-key" }, item.key),
        ])),
      }),
    ],
  });
}
