import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeProjectGroupsApi } from "./desktopNativeProjectGroups";

describe("desktop native project groups API", () => {
  test("uses the project group Tauri command contract", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeProjectGroupsApi({ invoke });

    await api.list();
    await api.save({ name: "Commerce", workspaceIds: ["D:\\gateway", "E:\\payments"] });
    await api.delete("project-group-1");

    expect(invoke.mock.calls).toEqual([
      ["worker_project_groups_list"],
      ["worker_project_group_save", {
        input: { name: "Commerce", workspaceIds: ["D:\\gateway", "E:\\payments"] },
      }],
      ["worker_project_group_delete", { input: { projectGroupId: "project-group-1" } }],
    ]);
  });
});
