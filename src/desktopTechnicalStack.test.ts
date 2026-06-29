import { describe, expect, test } from "vitest";
import {
  DESKTOP_TECHNICAL_BASELINE,
  buildDesktopDomainStoreRegistry,
  buildDesktopRouteRegistry,
  buildSharedComposableRegistry,
  resolveDesktopRoute,
} from "./desktopTechnicalStack";

describe("desktop technical stack registry", () => {
  test("declares the accepted native desktop frontend baseline", () => {
    expect(DESKTOP_TECHNICAL_BASELINE).toEqual({
      shell: "tauri",
      bundler: "vite",
      framework: "vue3",
      components: "naive-ui",
      router: "vue-router",
      state: "pinia",
    });
  });

  test("defines initial native workbench routes and settings deep links", () => {
    const routes = buildDesktopRouteRegistry();

    expect(routes.map((route) => [route.path, route.name, route.section ?? null])).toEqual([
      ["/chat", "chat", null],
      ["/chat/:chatId", "chat-session", null],
      ["/knowledge", "knowledge", null],
      ["/files", "files", null],
      ["/settings", "settings", "general"],
      ["/settings/:section", "settings-section", null],
    ]);
    expect(resolveDesktopRoute("/settings/provider-models")).toEqual({
      path: "/settings/provider-models",
      name: "settings-section",
      params: { section: "provider-models" },
      section: "provider-models",
    });
    expect(resolveDesktopRoute("/chat/session-1")).toEqual({
      path: "/chat/session-1",
      name: "chat-session",
      params: { chatId: "session-1" },
      section: null,
    });
  });

  test("declares domain stores for shared workbench state", () => {
    expect(buildDesktopDomainStoreRegistry().map((store) => [store.id, store.scope, store.events])).toEqual([
      ["runtime", "shell", ["gateway", "health", "model"]],
      ["chat", "page", ["stream", "usage", "references"]],
      ["socket", "shell", ["message", "approval", "task", "file", "cowork", "interrupted"]],
      ["files", "page", ["upload", "workspace", "promotion"]],
      ["knowledge", "page", ["readiness", "query", "graph", "index-job"]],
      ["settings", "page", ["provider", "validation", "save"]],
      ["approvals", "inspector", ["approval_pending", "approval_resolved"]],
      ["tasks", "inspector", ["task_started", "task_updated", "task_completed"]],
    ]);
  });

  test("declares shared composables used by future native routes", () => {
    expect(buildSharedComposableRegistry().map((composable) => composable.id)).toEqual([
      "useDesktopSocket",
      "useDesktopStreaming",
      "useDesktopTools",
      "useDesktopApprovals",
      "useDesktopForms",
      "useDesktopUploads",
      "useDesktopKnowledge",
      "useDesktopWorkspaceFiles",
      "useDesktopSettings",
      "useDesktopCommandPalette",
      "useDesktopNativeDialogs",
      "useDesktopHealth",
    ]);
  });
});
