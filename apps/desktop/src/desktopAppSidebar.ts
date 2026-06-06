import type {
  DesktopSidebarGroup,
  DesktopSidebarItem,
  DesktopSidebarModel,
} from "./desktopSharedModels";
import { mountDesktopAppSidebarIsland } from "./native-vue/desktopAppSidebarIsland";

export function renderDesktopAppSidebar(
  host: HTMLElement,
  model: DesktopSidebarModel,
  targetDocument: Document = document,
): void {
  host.classList.add("desktop-app-sidebar");
  host.classList.remove("desktop-app-sidebar-card");
  host.setAttribute("data-desktop-app-sidebar", "true");
  host.setAttribute("data-desktop-sidebar-mode", model.mode);
  host.setAttribute("aria-label", "Desktop navigation");

  if (canMountDesktopAppSidebarIsland(host)) {
    mountDesktopAppSidebarIsland(host, { model, targetDocument });
    return;
  }
  renderStaticDesktopAppSidebar(host, model, targetDocument);
}

function canMountDesktopAppSidebarIsland(host: HTMLElement): boolean {
  return typeof window !== "undefined" && host instanceof window.HTMLElement;
}

function renderStaticDesktopAppSidebar(
  host: HTMLElement,
  model: DesktopSidebarModel,
  targetDocument: Document,
): void {
  const content = targetDocument.createElement("nav");
  content.className = "desktop-app-sidebar-content";
  content.setAttribute("aria-label", "Desktop sidebar");

  for (const group of model.groups) {
    content.append(createStaticGroup(targetDocument, group));
  }

  host.replaceChildren(content);
}

function createStaticGroup(targetDocument: Document, group: DesktopSidebarGroup): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-app-sidebar-group";
  section.setAttribute("data-sidebar-group", group.id);

  const label = targetDocument.createElement("p");
  label.className = "desktop-app-sidebar-group-label";
  label.textContent = group.label ?? defaultGroupLabel(group.id);
  section.append(label);

  const list = targetDocument.createElement("div");
  list.className = "desktop-app-sidebar-list";
  list.setAttribute("role", "list");
  for (const item of group.items) {
    list.append(createStaticSidebarItem(targetDocument, item));
  }
  section.append(list);

  return section;
}

function createStaticSidebarItem(targetDocument: Document, item: DesktopSidebarItem): HTMLElement {
  const element = item.kind === "link" ? targetDocument.createElement("a") : targetDocument.createElement("button");
  element.className = "desktop-app-sidebar-item";
  element.setAttribute("data-sidebar-item-id", item.id);
  element.setAttribute("data-sidebar-item-kind", item.kind);
  element.setAttribute("role", "listitem");

  if (item.kind === "link" && item.href) {
    element.setAttribute("href", item.href);
    element.setAttribute("data-sidebar-href", item.href);
  } else {
    element.setAttribute("type", "button");
  }

  if (item.commandId) {
    element.setAttribute("data-sidebar-command", item.commandId);
    element.addEventListener("click", () => {
      if (item.disabled) {
        return;
      }
      targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", {
        detail: { id: item.commandId, source: "desktop-sidebar" },
      }));
    });
  }
  if (item.active) {
    element.setAttribute("data-active", "true");
    element.setAttribute("aria-current", "page");
  }
  if (item.disabled) {
    element.setAttribute("aria-disabled", "true");
  }
  if (item.icon) {
    element.setAttribute("data-sidebar-icon", item.icon);
  }
  if (item.shortcut) {
    element.setAttribute("data-sidebar-shortcut", item.shortcut);
  }

  const label = targetDocument.createElement("span");
  label.className = "desktop-app-sidebar-item-label";
  label.textContent = item.label;
  element.append(label);

  const detail = item.meta ?? item.shortcut;
  if (detail) {
    const meta = targetDocument.createElement("span");
    meta.className = "desktop-app-sidebar-item-meta";
    meta.textContent = detail;
    element.append(meta);
  }

  return element;
}

function defaultGroupLabel(groupId: DesktopSidebarGroup["id"]): string {
  switch (groupId) {
    case "actions":
      return "Actions";
    case "workspace":
      return "Workspace";
    case "footer":
      return "System";
  }
}
