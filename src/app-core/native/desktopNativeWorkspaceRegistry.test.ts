import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeWorkspaceRegistryApi } from "./desktopNativeWorkspaceRegistry";

describe("desktop native workspace registry API", () => {
  test("uses the workspace registry Tauri command contract", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeWorkspaceRegistryApi({ invoke });

    await api.list();
    await api.register("D:\\code\\tinybot");
    await api.rename("D:\\code\\tinybot", "Tinybot");
    await api.forget("D:\\code\\tinybot");

    expect(invoke.mock.calls).toEqual([
      ["worker_workspace_registry_list"],
      ["worker_workspace_register", { input: { path: "D:\\code\\tinybot" } }],
      ["worker_workspace_rename", {
        input: { path: "D:\\code\\tinybot", name: "Tinybot" },
      }],
      ["worker_workspace_forget", { input: { path: "D:\\code\\tinybot" } }],
    ]);
  });
});
