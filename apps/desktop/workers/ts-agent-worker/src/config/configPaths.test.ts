import { describe, expect, test } from "vitest";

import {
  isDefaultWorkspacePath,
  resolveTinybotRuntimePaths,
} from "./configPaths.ts";

describe("configPaths", () => {
  test("derives runtime paths from the active config path", () => {
    const paths = resolveTinybotRuntimePaths({
      configPath: "C:/Users/test/.tinybot/config.json",
      homeDir: "C:/Users/test",
      workspace: "D:/workspace/project",
    });

    expect(paths).toEqual({
      dataDir: "C:\\Users\\test\\.tinybot",
      mediaDir: "C:\\Users\\test\\.tinybot\\media",
      cronDir: "C:\\Users\\test\\.tinybot\\cron",
      logsDir: "C:\\Users\\test\\.tinybot\\logs",
      knowledgeDir: "C:\\Users\\test\\.tinybot\\knowledge",
      workspacePath: "D:\\workspace\\project",
      cliHistoryPath: "C:\\Users\\test\\.tinybot\\history\\cli_history",
      bridgeInstallDir: "C:\\Users\\test\\.tinybot\\bridge",
      legacySessionsDir: "C:\\Users\\test\\.tinybot\\sessions",
    });
  });

  test("uses Python-compatible defaults when config path and workspace are omitted", () => {
    const paths = resolveTinybotRuntimePaths({ homeDir: "C:/Users/test" });

    expect(paths.dataDir).toBe("C:\\Users\\test\\.tinybot");
    expect(paths.workspacePath).toBe("C:\\Users\\test\\.tinybot\\workspace");
    expect(isDefaultWorkspacePath(paths.workspacePath, "C:/Users/test")).toBe(true);
  });

  test("expands home-relative workspace and detects non-default workspace paths", () => {
    const paths = resolveTinybotRuntimePaths({
      homeDir: "C:/Users/test",
      workspace: "~/.tinybot/workspace-alt",
    });

    expect(paths.workspacePath).toBe("C:\\Users\\test\\.tinybot\\workspace-alt");
    expect(isDefaultWorkspacePath(paths.workspacePath, "C:/Users/test")).toBe(false);
  });
});
