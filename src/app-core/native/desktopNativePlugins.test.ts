import { describe, expect, test, vi } from "vitest";
import { createDesktopNativePluginsApi } from "./desktopNativePlugins";

describe("desktop native plugins API", () => {
  test("manages Agent Plugins through the Rust command surface", async () => {
    const invoke = vi.fn(async () => ({}));
    const api = createDesktopNativePluginsApi({ invoke });

    await api.list();
    await api.install("D:\\plugins\\review-tools");
    await api.prepareMigration("D:\\skills\\legacy-skill");
    await api.installMigration("migration-1");
    await api.setEnabled("review-tools", true);
    await api.uninstall("review-tools");

    expect(invoke.mock.calls).toEqual([
      ["worker_plugins_list"],
      ["worker_plugin_install", { input: { path: "D:\\plugins\\review-tools" } }],
      ["worker_plugin_prepare_migration", { input: { path: "D:\\skills\\legacy-skill" } }],
      ["worker_plugin_install_migration", { input: { jobId: "migration-1" } }],
      ["worker_plugin_set_enabled", { input: { enabled: true, name: "review-tools" } }],
      ["worker_plugin_uninstall", { input: { name: "review-tools" } }],
    ]);
  });
});
