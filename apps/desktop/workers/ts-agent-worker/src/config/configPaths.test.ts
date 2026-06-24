import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  isDefaultWorkspacePath,
  resolveTinybotRuntimePaths,
} from "./configPaths.ts";

describe("configPaths", () => {
  test("derives runtime paths from the active config path", () => {
    const homeDir = path.normalize("C:/Users/test");
    const dataDir = path.join(homeDir, ".tinybot");
    const paths = resolveTinybotRuntimePaths({
      configPath: "C:/Users/test/.tinybot/config.json",
      homeDir: "C:/Users/test",
      workspace: "D:/workspace/project",
    });

    expect(paths).toEqual({
      dataDir,
      mediaDir: path.join(dataDir, "media"),
      cronDir: path.join(dataDir, "cron"),
      logsDir: path.join(dataDir, "logs"),
      knowledgeDir: path.join(dataDir, "knowledge"),
      workspacePath: path.normalize("D:/workspace/project"),
      cliHistoryPath: path.join(homeDir, ".tinybot", "history", "cli_history"),
      bridgeInstallDir: path.join(homeDir, ".tinybot", "bridge"),
      legacySessionsDir: path.join(homeDir, ".tinybot", "sessions"),
    });
  });

  test("uses Python-compatible defaults when config path and workspace are omitted", () => {
    const homeDir = path.normalize("C:/Users/test");
    const paths = resolveTinybotRuntimePaths({ homeDir: "C:/Users/test" });

    expect(paths.dataDir).toBe(path.join(homeDir, ".tinybot"));
    expect(paths.workspacePath).toBe(path.join(homeDir, ".tinybot", "workspace"));
    expect(isDefaultWorkspacePath(paths.workspacePath, "C:/Users/test")).toBe(true);
  });

  test("expands home-relative workspace and detects non-default workspace paths", () => {
    const homeDir = path.normalize("C:/Users/test");
    const paths = resolveTinybotRuntimePaths({
      homeDir: "C:/Users/test",
      workspace: "~/.tinybot/workspace-alt",
    });

    expect(paths.workspacePath).toBe(path.join(homeDir, ".tinybot", "workspace-alt"));
    expect(isDefaultWorkspacePath(paths.workspacePath, "C:/Users/test")).toBe(false);
  });
});
