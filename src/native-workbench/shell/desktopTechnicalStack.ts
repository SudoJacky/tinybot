export const DESKTOP_TECHNICAL_BASELINE = {
  shell: "tauri",
  bundler: "vite",
  framework: "vue3",
  components: "naive-ui",
  router: "vue-router",
  state: "pinia",
} as const;

export type DesktopRouteName =
  | "chat"
  | "chat-session"
  | "knowledge"
  | "files"
  | "settings"
  | "settings-section";

export interface DesktopRouteDefinition {
  path: string;
  name: DesktopRouteName;
  section?: string | null;
}

export interface ResolvedDesktopRoute {
  path: string;
  name: DesktopRouteName;
  params: Record<string, string>;
  section: string | null;
}

export type DesktopDomainStoreScope = "shell" | "page" | "inspector";

export interface DesktopDomainStoreDefinition {
  id: "runtime" | "chat" | "socket" | "files" | "knowledge" | "settings" | "approvals" | "tasks";
  scope: DesktopDomainStoreScope;
  events: string[];
}

export interface DesktopComposableDefinition {
  id:
    | "useDesktopSocket"
    | "useDesktopStreaming"
    | "useDesktopTools"
    | "useDesktopApprovals"
    | "useDesktopForms"
    | "useDesktopUploads"
    | "useDesktopKnowledge"
    | "useDesktopWorkspaceFiles"
    | "useDesktopSettings"
    | "useDesktopCommandPalette"
    | "useDesktopNativeDialogs"
    | "useDesktopHealth";
  domain: string;
}

const DESKTOP_ROUTES: DesktopRouteDefinition[] = [
  { path: "/chat", name: "chat" },
  { path: "/chat/:chatId", name: "chat-session" },
  { path: "/knowledge", name: "knowledge" },
  { path: "/files", name: "files" },
  { path: "/settings", name: "settings", section: "general" },
  { path: "/settings/:section", name: "settings-section" },
];

const DESKTOP_DOMAIN_STORES: DesktopDomainStoreDefinition[] = [
  { id: "runtime", scope: "shell", events: ["gateway", "health", "model"] },
  { id: "chat", scope: "page", events: ["stream", "usage", "references"] },
  { id: "socket", scope: "shell", events: ["message", "approval", "task", "file", "cowork", "interrupted"] },
  { id: "files", scope: "page", events: ["upload", "workspace", "promotion"] },
  { id: "knowledge", scope: "page", events: ["readiness", "query", "graph", "index-job"] },
  { id: "settings", scope: "page", events: ["provider", "validation", "save"] },
  { id: "approvals", scope: "inspector", events: ["approval_pending", "approval_resolved"] },
  { id: "tasks", scope: "inspector", events: ["task_started", "task_updated", "task_completed"] },
];

const DESKTOP_COMPOSABLES: DesktopComposableDefinition[] = [
  { id: "useDesktopSocket", domain: "socket" },
  { id: "useDesktopStreaming", domain: "chat" },
  { id: "useDesktopTools", domain: "tools" },
  { id: "useDesktopApprovals", domain: "approvals" },
  { id: "useDesktopForms", domain: "forms" },
  { id: "useDesktopUploads", domain: "files" },
  { id: "useDesktopKnowledge", domain: "knowledge" },
  { id: "useDesktopWorkspaceFiles", domain: "files" },
  { id: "useDesktopSettings", domain: "settings" },
  { id: "useDesktopCommandPalette", domain: "command-palette" },
  { id: "useDesktopNativeDialogs", domain: "native-dialogs" },
  { id: "useDesktopHealth", domain: "runtime" },
];

export function buildDesktopRouteRegistry(): DesktopRouteDefinition[] {
  return DESKTOP_ROUTES.map((route) => ({ ...route }));
}

export function resolveDesktopRoute(path: string): ResolvedDesktopRoute {
  const url = new URL(path, "http://tinybot.local");
  const pathname = normalizePathname(url.pathname);
  if (pathname === "/chat") {
    return resolved(pathname, "chat");
  }
  if (pathname.startsWith("/chat/")) {
    return resolved(pathname, "chat-session", { chatId: decodeURIComponent(pathname.slice("/chat/".length)) });
  }
  if (pathname === "/knowledge") {
    return resolved(pathname, "knowledge");
  }
  if (pathname === "/files") {
    return resolved(pathname, "files");
  }
  if (pathname === "/settings") {
    return resolved(pathname, "settings", {}, "general");
  }
  if (pathname.startsWith("/settings/")) {
    const section = decodeURIComponent(pathname.slice("/settings/".length));
    return resolved(pathname, "settings-section", { section }, section);
  }
  return resolved("/chat", "chat");
}

export function buildDesktopDomainStoreRegistry(): DesktopDomainStoreDefinition[] {
  return DESKTOP_DOMAIN_STORES.map((store) => ({ ...store, events: [...store.events] }));
}

export function buildSharedComposableRegistry(): DesktopComposableDefinition[] {
  return DESKTOP_COMPOSABLES.map((composable) => ({ ...composable }));
}

function resolved(
  path: string,
  name: DesktopRouteName,
  params: Record<string, string> = {},
  section: string | null = null,
): ResolvedDesktopRoute {
  return { path, name, params, section };
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}
