import { describe, expect, it } from "vitest";
import { projectSessionGroups } from "./projectSessionGroups";

describe("projectSessionGroups", () => {
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
