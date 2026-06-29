import path from "node:path";

export type RuntimePathInput = {
  configPath?: string | null;
  homeDir: string;
  workspace?: string | null;
};

export type TinybotRuntimePaths = {
  dataDir: string;
  mediaDir: string;
  cronDir: string;
  logsDir: string;
  knowledgeDir: string;
  workspacePath: string;
  cliHistoryPath: string;
  bridgeInstallDir: string;
  legacySessionsDir: string;
};

export function resolveTinybotRuntimePaths(input: RuntimePathInput): TinybotRuntimePaths {
  const homeDir = normalize(input.homeDir);
  const configPath = input.configPath ? expandHome(input.configPath, homeDir) : path.join(homeDir, ".tinybot", "config.json");
  const dataDir = path.dirname(normalize(configPath));
  return {
    dataDir,
    mediaDir: path.join(dataDir, "media"),
    cronDir: path.join(dataDir, "cron"),
    logsDir: path.join(dataDir, "logs"),
    knowledgeDir: path.join(dataDir, "knowledge"),
    workspacePath: resolveWorkspacePath(input.workspace, homeDir),
    cliHistoryPath: path.join(homeDir, ".tinybot", "history", "cli_history"),
    bridgeInstallDir: path.join(homeDir, ".tinybot", "bridge"),
    legacySessionsDir: path.join(homeDir, ".tinybot", "sessions"),
  };
}

export function resolveWorkspacePath(workspace: string | null | undefined, homeDir: string): string {
  const home = normalize(homeDir);
  const raw = workspace?.trim() || path.join(home, ".tinybot", "workspace");
  return normalize(expandHome(raw, home));
}

export function isDefaultWorkspacePath(workspace: string | null | undefined, homeDir: string): boolean {
  const home = normalize(homeDir);
  return normalize(resolveWorkspacePath(workspace, home)).toLowerCase() === path.join(home, ".tinybot", "workspace").toLowerCase();
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function normalize(value: string): string {
  return path.normalize(value.replaceAll("/", path.sep));
}
