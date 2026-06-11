import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeSkillsApi } from "./desktopNativeSkills";

describe("desktop native skills API", () => {
  test("loads skills list and detail through TS worker Tauri commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeSkillsApi({ invoke });

    await expect(api.list()).resolves.toEqual({
      command: "worker_skills_list",
      args: undefined,
    });
    await expect(api.detail("planner/phase")).resolves.toEqual({
      command: "worker_skills_detail",
      args: { input: { name: "planner/phase" } },
    });
  });
});
