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
    await api.saveManaged({
      workspacePath: "D:\\work",
      name: "Protect files",
      event: "PreToolUse",
      matcher: "^workspace\\.",
      language: "powershell",
      enabled: true,
      timeout: 30,
    });
    await api.testManaged({ workspacePath: "D:\\work", id: "protect-files" });
    await api.archiveManaged({ workspacePath: "D:\\work", id: "protect-files" });
    await api.readManagedScript({ workspacePath: "D:\\work", id: "protect-files" });
    await api.saveManagedScript({
      workspacePath: "D:\\work",
      id: "protect-files",
      contents: "# edited\n",
      expectedRevision: "sha256:before",
    });

    expect(invoke.mock.calls).toEqual([
      ["worker_hooks_snapshot", { input: { workspacePath: "D:\\work" } }],
      ["worker_hook_set_trusted", {
        input: { workspacePath: "D:\\work", hash: "sha256:abc", trusted: true },
      }],
      ["worker_managed_hook_save", {
        input: {
          workspacePath: "D:\\work",
          name: "Protect files",
          event: "PreToolUse",
          matcher: "^workspace\\.",
          language: "powershell",
          enabled: true,
          timeout: 30,
        },
      }],
      ["worker_managed_hook_test", {
        input: { workspacePath: "D:\\work", id: "protect-files" },
      }],
      ["worker_managed_hook_archive", {
        input: { workspacePath: "D:\\work", id: "protect-files" },
      }],
      ["worker_managed_hook_script_read", {
        input: { workspacePath: "D:\\work", id: "protect-files" },
      }],
      ["worker_managed_hook_script_save", {
        input: {
          workspacePath: "D:\\work",
          id: "protect-files",
          contents: "# edited\n",
          expectedRevision: "sha256:before",
        },
      }],
    ]);
  });
});
