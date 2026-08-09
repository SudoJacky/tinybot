import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeMemoryApi } from "./desktopNativeMemory";

describe("desktop native memory API", () => {
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
