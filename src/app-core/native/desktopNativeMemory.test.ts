import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeMemoryApi } from "./desktopNativeMemory";

describe("desktop native memory API", () => {
  test("sends mutations with the snapshot revision", async () => {
    const invoke = vi.fn(async () => ({ revision: 8, currentWorkspacePath: "D:/workspace", entries: [] }));
    const api = createDesktopNativeMemoryApi({ invoke });
    const request = { expectedRevision: 7, mutation: { operation: "delete" as const, ids: [2, 9] } };
    await expect(api.mutate(request)).resolves.toMatchObject({ revision: 8 });
    expect(invoke).toHaveBeenCalledWith("worker_memory_mutate", request);
  });
  test("loads the canonical active memory snapshot through Tauri", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeMemoryApi({ invoke });

    await expect(api.snapshot()).resolves.toEqual({
      command: "worker_memory_snapshot",
      args: undefined,
    });
  });
});
