import { describe, expect, it } from "vitest";
import { projectSessionGroups } from "./projectSessionGroups";

describe("projectSessionGroups", () => {
  it("keeps project order independent of conversation recency", () => {
    const projects = ["first", "second"].map((projectGroupId) => ({ projectGroupId, name: projectGroupId, workspaceIds: [] }));
    const result = projectSessionGroups(projects, [
      { id: "newer", title: "Newer", projectGroupId: "second", projectCoordinator: true, updatedAtMs: 20 },
      { id: "older", title: "Older", projectGroupId: "first", projectCoordinator: true, updatedAtMs: 10 },
    ]);
    expect(result.groups.map((group) => group.project.projectGroupId)).toEqual(["first", "second"]);
  });

  it("groups only project-scoped sessions and leaves unrelated workspace sessions standalone", () => {
    const result = projectSessionGroups([{
      projectGroupId: "commerce",
      name: "Commerce",
      workspaceIds: ["D:\\Repos\\gateway", "E:\\Services\\payments"],
    }], [
      {
        id: "coordinator",
        title: "Coordinate rollout",
        updatedAtMs: 3,
        projectCoordinator: true,
        projectGroupId: "commerce",
      },
      {
        id: "payment",
        title: "Implement refund",
        updatedAtMs: 2,
        projectGroupId: "commerce",
        workingDirectory: "e:/services/payments/",
      },
      {
        id: "ordinary",
        title: "Unscoped payment chat",
        updatedAtMs: 1,
        workingDirectory: "E:\\Services\\payments",
      },
    ]);

    expect(result.groups[0].coordinatorSessions.map((session) => session.id)).toEqual(["coordinator"]);
    expect(result.groups[0].workspaces[1].sessions.map((session) => session.id)).toEqual(["payment"]);
    expect(result.ungroupedSessions.map((session) => session.id)).toEqual(["ordinary"]);
  });
});
