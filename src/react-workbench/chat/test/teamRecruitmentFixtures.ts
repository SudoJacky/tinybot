import type { TeamRun } from "../../../app-core/native/desktopNativeTeams";

/** Canonical persisted calls, deliberately including cumulative coordinator snapshots. */
export function recruitmentRun(): TeamRun {
  return {
    id: "recruitment-run", schemaVersion: 3, revision: 3, parentThreadId: "recruitment-chat", finalTaskId: "",
    status: "running", error: null, createdAt: "2026-09-26", updatedAt: "2026-09-26",
    spec: { goal: "Compare agent designs", workspacePath: "/workspace", maxConcurrency: 2,
      members: [
        { id: "researcher-a", displayName: "Alex", instructions: "Research sources" },
        { id: "analyst", displayName: "Sam", instructions: "Compare designs" },
        { id: "researcher-b", displayName: "Alex", instructions: "Verify evidence" },
      ] },
    tasks: [
      { id: "sources", memberId: "researcher-a", title: "Collect sources" },
      { id: "compare", memberId: "analyst", title: "Compare designs" },
      { id: "verify", memberId: "researcher-b", title: "Verify evidence" },
    ].map(task => ({ task: { ...task, instructions: "Return evidence and an internal handoff", dependencies: [] }, status: "running", attempts: [
      { threadId: `${task.id}-worker`, turnId: "worker-turn", status: "running", startedAt: "2026-09-26", finishedAt: null, output: null, error: null },
    ] })),
  };
}

export function recruitmentRuntime(run: TeamRun, batches: string[][] = [["sources", "compare"], ["verify"]]) {
  const members = new Set<string>();
  const cumulative = new Set<string>();
  const sessionId = "recruitment-chat", turnId = "recruitment-turn";
  const items = batches.map((ids, index) => {
    const tasks = ids.map(id => run.tasks.find(record => record.task.id === id)!.task);
    const added = run.spec.members.filter(member => !members.has(member.id) && tasks.some(task => task.memberId === member.id));
    added.forEach(member => members.add(member.id));
    ids.forEach(id => cumulative.add(id));
    return {
      schemaVersion: "tinybot.turn_item.v2", itemId: `recruit-${index}`, sessionId, turnId, sequence: index + 1, revision: 1,
      kind: "tool_call", title: "team.recruit", status: "completed", createdAt: "2026-09-26T06:00:00Z",
      data: { type: "tool_call", toolCallId: `recruit-${index}`, name: "team.recruit", status: "completed",
        args: { ...(index ? { runId: run.id } : { goal: run.spec.goal }), members: added,
          tasks: tasks.map(task => ({ ...task, instructions: `${task.instructions}\n${"Verify original evidence. ".repeat(200)}` })) },
        result: { status: "success", raw: { runId: run.id, revision: index + 1, status: "running",
          tasks: run.tasks.filter(record => cumulative.has(record.task.id)).map(record => ({ taskId: record.task.id, memberId: record.task.memberId, title: record.task.title, status: record.status })) } },
      },
    };
  });
  return { status: "completed", runtimeEvents: [], timeline: { schemaVersion: "tinybot.timeline.v2", sessionId, turnId, snapshotRevision: items.length, items } };
}
