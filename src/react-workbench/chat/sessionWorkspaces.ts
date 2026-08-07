import type { SessionSummary } from "../services";

export const GENERAL_SESSION_WORKSPACE_KEY = "session-workspace:general";

export type SessionWorkspaceGroup = {
  key: string;
  label: string;
  sessions: SessionSummary[];
  updatedAtMs: number;
  workingDirectory?: string;
};

export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionWorkspaceGroup[] {
  const groups = new Map<string, SessionWorkspaceGroup>();
  for (const session of sessions) {
    const workingDirectory = normalizedDisplayPath(
      session.pluginMigration ? undefined : session.workingDirectory,
    );
    const pathKey = workingDirectory ? normalizedWorkspacePathKey(workingDirectory) : "";
    const key = pathKey ? `session-workspace:${pathKey}` : GENERAL_SESSION_WORKSPACE_KEY;
    const current = groups.get(key);
    if (current) {
      current.sessions.push(session);
      current.updatedAtMs = Math.max(current.updatedAtMs, session.updatedAtMs);
      continue;
    }
    groups.set(key, {
      key,
      label: workingDirectory ? sessionWorkspaceName(workingDirectory) : "常规会话",
      sessions: [session],
      updatedAtMs: session.updatedAtMs,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
  }
  return [...groups.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function sessionWorkspaceName(workingDirectory: string): string {
  const path = normalizedDisplayPath(workingDirectory);
  if (!path) {
    return "常规会话";
  }
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizedDisplayPath(value: string | undefined): string {
  const path = value?.trim() ?? "";
  if (!path) {
    return "";
  }
  const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators || path;
}

function normalizedWorkspacePathKey(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  const windowsPath = /^[a-zA-Z]:\//.test(slashPath) || slashPath.startsWith("//");
  return windowsPath ? slashPath.toLocaleLowerCase("en-US") : slashPath;
}
