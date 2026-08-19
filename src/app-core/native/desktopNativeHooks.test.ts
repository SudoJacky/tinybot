import { describe, expect, test, vi } from "vitest";
import { createDesktopNativeHooksApi } from "./desktopNativeHooks";

describe("desktop native hooks API", () => {
  test("loads and updates exact-definition trust through Tauri", async () => {
    const invoke = vi.fn(async () => ({ hooks: [] }));
    const api = createDesktopNativeHooksApi({ invoke });

    await api.snapshot("D:\\work");
    await api.setTrusted({
      workspacePath: "D:\\work",
      hash: "sha256:abc",
      trusted: true,
    });

    expect(invoke.mock.calls).toEqual([
      ["worker_hooks_snapshot", { input: { workspacePath: "D:\\work" } }],
      ["worker_hook_set_trusted", {
        input: { workspacePath: "D:\\work", hash: "sha256:abc", trusted: true },
      }],
    ]);
  });
});
