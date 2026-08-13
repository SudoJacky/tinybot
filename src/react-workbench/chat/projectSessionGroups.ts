import type { ProjectGroup, SessionSummary } from "../services";
import { normalizedWorkspacePathKey, sessionWorkspaceName } from "./sessionWorkspaces";

export type ProjectWorkspaceSessions = {
  label: string;
  sessions: SessionSummary[];
  workspaceId: string;
};

export type ProjectSessionGroup = {
  coordinatorSessions: SessionSummary[];
  project: ProjectGroup;
  updatedAtMs: number;
  workspaces: ProjectWorkspaceSessions[];
};

export function projectSessionGroups(
  projects: ProjectGroup[],
  sessions: SessionSummary[],
): { groups: ProjectSessionGroup[]; ungroupedSessions: SessionSummary[] } {
  const groupedSessionIds = new Set<string>();
  const groups = projects.map((project) => {
    const coordinatorSessions = sessions.filter((session) => (
      session.projectCoordinator && session.projectGroupId === project.projectGroupId
    ));
    coordinatorSessions.forEach((session) => groupedSessionIds.add(session.id));
    const workspaces = project.workspaceIds.map((workspaceId) => {
      const workspaceKey = normalizedWorkspacePathKey(workspaceId);
      const workspaceSessions = sessions.filter((session) => (
        !session.projectCoordinator
        && session.projectGroupId === project.projectGroupId
        && Boolean(session.workingDirectory)
        && normalizedWorkspacePathKey(session.workingDirectory!) === workspaceKey
      ));
      workspaceSessions.forEach((session) => groupedSessionIds.add(session.id));
      return {
        label: sessionWorkspaceName(workspaceId),
        sessions: workspaceSessions,
        workspaceId,
      };
    });
    const updatedAtMs = [...coordinatorSessions, ...workspaces.flatMap((workspace) => workspace.sessions)]
      .reduce((latest, session) => Math.max(latest, session.updatedAtMs), 0);
    return { coordinatorSessions, project, updatedAtMs, workspaces };
  }).sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    groups,
    ungroupedSessions: sessions.filter((session) => !groupedSessionIds.has(session.id)),
  };
}
