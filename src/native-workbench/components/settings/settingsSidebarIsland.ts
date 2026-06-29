import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NInput, NMenu, type MenuOption } from "naive-ui";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

type SettingsGroup = DesktopSettingsPaneModel["groups"][number];

export interface SettingsSidebarIslandOptions {
  groups: DesktopSettingsPaneModel["groups"];
}

export interface MountedSettingsSidebarIsland {
  unmount: () => void;
}

export function mountSettingsSidebarIsland(
  host: HTMLElement,
  options: SettingsSidebarIslandOptions,
): MountedSettingsSidebarIsland {
  host.setAttribute("data-desktop-vue-island", "settings-sidebar");
  host.className = "desktop-settings-sidebar";
  host.setAttribute("aria-label", "Settings navigation");
  const app = createSettingsSidebarApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsSidebarApp(options: SettingsSidebarIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsSidebarIsland",
    setup() {
      const activeGroupId = ref(options.groups[0]?.id ?? "general");
      const setActiveGroupId = (groupId: SettingsGroup["id"]) => {
        activeGroupId.value = groupId;
      };
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NInput, {
            class: "desktop-settings-search",
            placeholder: "Search settings...",
            "aria-label": "Search settings",
          }),
          h(NMenu, {
            class: "desktop-settings-nav",
            options: buildSettingsMenuOptions(options.groups, activeGroupId.value, setActiveGroupId),
            value: activeGroupId.value,
          }),
        ],
      });
    },
  }));
}

function buildSettingsMenuOptions(
  groups: SettingsGroup[],
  activeGroupId: SettingsGroup["id"],
  setActiveGroupId: (groupId: SettingsGroup["id"]) => void,
): MenuOption[] {
  const personalGroups = groups.slice(0, 3);
  const systemGroups = groups.slice(3);
  return [
    {
      key: "personal",
      label: () => h("p", { class: "desktop-settings-nav-heading" }, "Personal"),
      type: "group",
      children: personalGroups.map((group) => renderNavOption(group, activeGroupId, setActiveGroupId)),
    },
    {
      key: "system",
      label: () => h("p", { class: "desktop-settings-nav-heading" }, "System"),
      type: "group",
      children: systemGroups.map((group) => renderNavOption(group, activeGroupId, setActiveGroupId)),
    },
  ];
}

function renderNavOption(
  group: SettingsGroup,
  activeGroupId: SettingsGroup["id"],
  setActiveGroupId: (groupId: SettingsGroup["id"]) => void,
): MenuOption {
  return {
    key: group.id,
    label: () => renderNavItem(group, activeGroupId, setActiveGroupId),
  };
}

function renderNavItem(
  group: SettingsGroup,
  activeGroupId: SettingsGroup["id"],
  setActiveGroupId: (groupId: SettingsGroup["id"]) => void,
) {
  const attrs: Record<string, string | ((event: Event) => void)> = {
    class: "desktop-settings-nav-item",
    href: `#desktop-settings-group-${group.id}`,
    "data-desktop-settings-nav": group.id,
    onClick: (event: Event) => scrollToSettingsGroup(event, group.id, setActiveGroupId),
  };
  if (group.id === activeGroupId) {
    attrs["data-active"] = "true";
    attrs["aria-current"] = "page";
  }
  return h("a", attrs, getSettingsNavLabel(group.id));
}

function scrollToSettingsGroup(
  event: Event,
  groupId: SettingsGroup["id"],
  setActiveGroupId: (groupId: SettingsGroup["id"]) => void,
): void {
  event.preventDefault();
  setActiveGroupId(groupId);
  const link = event.currentTarget as HTMLElement | null;
  const target = link?.ownerDocument.getElementById(`desktop-settings-group-${groupId}`);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function getSettingsNavLabel(groupId: SettingsGroup["id"]): string {
  return {
    general: "General",
    "provider-models": "Provider & Models",
    knowledge: "Knowledge",
    "tools-approvals": "Tools & Approvals",
    "files-workspace": "Files & Workspace",
    "memory-experience": "Memory & Experience",
    skills: "Skills",
    channels: "Channels",
    automations: "Automations",
    "gateway-runtime": "Gateway & Runtime",
    "logs-diagnostics": "Logs & Diagnostics",
  }[groupId];
}
