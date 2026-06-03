export type DesktopWorkbenchEntityModule =
  | "chat"
  | "workspace"
  | "knowledge"
  | "tools"
  | "skills"
  | "settings"
  | "approvals"
  | "cowork"
  | "docs"
  | "gateway";

export interface DesktopEntityDestination {
  module: DesktopWorkbenchEntityModule;
  entityId?: string;
}

export function moduleForDesktopWorkbenchPath(pathname: string): DesktopWorkbenchEntityModule | "" {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) {
    return "chat";
  }
  if (pathname === "/workspace" || pathname.startsWith("/workspace/")) {
    return "workspace";
  }
  if (pathname === "/knowledge" || pathname.startsWith("/knowledge/")) {
    return "knowledge";
  }
  if (pathname === "/tools" || pathname.startsWith("/tools/")) {
    return "tools";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  if (pathname === "/cowork" || pathname.startsWith("/cowork/")) {
    return "cowork";
  }
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return "docs";
  }
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/v1/knowledge/")) {
    return "gateway";
  }
  return "";
}

export function applyDesktopWorkbenchRouteState(targetDocument: Document, pathname: string): DesktopWorkbenchEntityModule | "" {
  const module = moduleForDesktopWorkbenchPath(pathname);
  if (module) {
    targetDocument.documentElement.dataset.desktopActiveWorkbenchModule = module;
  }
  return module;
}

export function focusDesktopEntity(targetDocument: Document, destination: DesktopEntityDestination): boolean {
  if (!destination.entityId) {
    return false;
  }
  targetDocument.documentElement.dataset.desktopPaletteFocusModule = destination.module;
  targetDocument.documentElement.dataset.desktopPaletteFocusEntity = destination.entityId;
  const target = focusSelectorsFor(destination)
    .map((selector) => targetDocument.querySelector<HTMLElement>(selector))
    .find((element): element is HTMLElement => Boolean(element));
  if (!target) {
    return false;
  }
  if (typeof target.focus === "function") {
    target.focus();
  }
  targetDocument.documentElement.dataset.desktopPaletteFocused = "true";
  return true;
}

function focusSelectorsFor(destination: DesktopEntityDestination): string[] {
  const entity = destination.entityId ? selectorValue(destination.entityId) : "";
  const generic = `[data-desktop-entity-module="${selectorValue(destination.module)}"][data-desktop-entity-id="${entity}"]`;
  switch (destination.module) {
    case "workspace":
      return [generic, `[data-desktop-workspace-file="${entity}"]`];
    case "chat":
      return [generic, `[data-session-key="${entity}"]`];
    case "cowork":
      return [generic, `[data-cowork-session="${entity}"]`, `[data-desktop-cowork-session="${entity}"]`];
    default:
      return [generic];
  }
}

function selectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
