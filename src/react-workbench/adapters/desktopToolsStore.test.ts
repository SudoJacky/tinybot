import { describe, expect, it, vi } from "vitest";
import type {
  NativePluginMigrationInstallResult,
  NativePluginMigrationJob,
  NativePluginSummary,
  NativePluginsApi,
} from "../../app-core/native/desktopNativePlugins";
import { createDesktopToolsStore } from "./desktopToolsStore";

function plugin(name: string, enabled = true): NativePluginSummary {
  return {
    name,
    builtIn: false,
    enabled,
    valid: true,
    installedAtMs: 1,
    sourcePath: `source/${name}`,
    installPath: `plugins/${name}`,
    skills: [],
    mcpServers: [],
    diagnostics: [],
  };
}

function createNativePlugins(): NativePluginsApi {
  const installed = plugin("installed");
  const migrationJob: NativePluginMigrationJob = {
    jobId: "migration-1",
    workingDirectory: "work/migration-1",
    sourceDirectory: "legacy/plugin",
    outputDirectory: "work/migration-1/output",
    detectedArtifacts: ["SKILL.md"],
  };
  const migrationResult: NativePluginMigrationInstallResult = { plugin: installed };
  return {
    list: vi.fn(async () => ({ plugins: [plugin("existing")] })),
    install: vi.fn(async () => installed),
    prepareMigration: vi.fn(async () => migrationJob),
    installMigration: vi.fn(async () => migrationResult),
    setEnabled: vi.fn(async (name, enabled) => plugin(name, enabled)),
    uninstall: vi.fn(async () => undefined),
  };
}

describe("desktop tools store", () => {
  it("normalizes the native tool catalog through the ToolsStore interface", async () => {
    const initialize = vi.fn(async () => undefined);
    const route = vi.fn(async () => ({
      tools: [{
        id: "filesystem.read",
        title: "Read file",
        description: "Reads a workspace file.",
        serverId: "filesystem",
        enabled: false,
        reason: "Disabled by policy",
      }],
      mcpServers: [{
        id: "filesystem",
        enabled: false,
        source: "workspace/.mcp.json",
        status: { state: "failed", toolCount: "3", lastError: "Connection failed" },
      }],
      skills: [{
        id: "workspace:review-work",
        name: "review-work",
        description: "Review workspace changes.",
        source: "workspace",
        path: "workspace/.agents/skills/review-work/SKILL.md",
      }],
    }));
    const store = createDesktopToolsStore({ initialize, nativeWebui: { route } });

    await expect(store.loadCatalog()).resolves.toEqual({
      tools: [{
        id: "filesystem.read",
        name: "filesystem.read",
        displayName: "Read file",
        description: "Reads a workspace file.",
        source: "builtin",
        serverId: "filesystem",
        enabled: false,
        available: true,
        reason: "Disabled by policy",
      }],
      mcpServers: [{
        id: "filesystem",
        enabled: false,
        transport: "stdio",
        state: "failed",
        toolCount: 3,
        source: "workspace/.mcp.json",
        error: "Connection failed",
      }],
      skills: [{
        id: "workspace:review-work",
        name: "review-work",
        description: "Review workspace changes.",
        source: "workspace",
        path: "workspace/.agents/skills/review-work/SKILL.md",
      }],
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith({ method: "GET", path: "/api/tools" });
  });

  it("delegates plugin lifecycle operations after initialization", async () => {
    const initialize = vi.fn(async () => undefined);
    const nativePlugins = createNativePlugins();
    const store = createDesktopToolsStore({ initialize, nativePlugins });

    await expect(store.listPlugins()).resolves.toEqual([plugin("existing")]);
    await expect(store.installPlugin("plugin.zip")).resolves.toEqual(plugin("installed"));
    await expect(store.preparePluginMigration("legacy/plugin")).resolves.toMatchObject({ jobId: "migration-1" });
    await expect(store.installPluginMigration("migration-1")).resolves.toEqual({ plugin: plugin("installed") });
    await expect(store.setPluginEnabled("existing", false)).resolves.toEqual(plugin("existing", false));
    await expect(store.uninstallPlugin("existing")).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(6);
    expect(nativePlugins.install).toHaveBeenCalledWith("plugin.zip");
    expect(nativePlugins.prepareMigration).toHaveBeenCalledWith("legacy/plugin");
    expect(nativePlugins.installMigration).toHaveBeenCalledWith("migration-1");
    expect(nativePlugins.setEnabled).toHaveBeenCalledWith("existing", false);
    expect(nativePlugins.uninstall).toHaveBeenCalledWith("existing");
  });

  it("loads and normalizes skill details through the dedicated route", async () => {
    const initialize = vi.fn(async () => undefined);
    const route = vi.fn(async () => ({
      id: "workspace:review-work",
      name: "review-work",
      description: "Review workspace changes.",
      source: "workspace",
      path: "workspace/.agents/skills/review-work/SKILL.md",
      content: "---\nname: review-work\n---\nReview the diff.\n",
    }));
    const store = createDesktopToolsStore({ initialize, nativeWebui: { route } });

    await expect(store.loadSkillDetail("workspace:review-work")).resolves.toMatchObject({
      id: "workspace:review-work",
      content: expect.stringContaining("Review the diff."),
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/tools/skills/workspace%3Areview-work",
    });
  });

  it("preserves native catalog failures", async () => {
    const failure = new Error("tool catalog unavailable");
    const route = vi.fn(async () => Promise.reject(failure));
    const store = createDesktopToolsStore({ initialize: async () => undefined, nativeWebui: { route } });

    await expect(store.loadCatalog()).rejects.toBe(failure);
  });
});
