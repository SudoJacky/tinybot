import { describe, expect, it } from "vitest";

import { createMemoryCoworkStore, CoworkService, type CoworkIdGenerator } from "./coworkService";
import { createCoworkInternalTool } from "./coworkInternalTool";

const fixedNow = "2026-06-12T08:00:00.000Z";

function deterministicIds(): CoworkIdGenerator {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

describe("cowork_internal tool", () => {
  it("marks non-swarm sessions completed after the final task is completed", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Finish the migration",
      title: "Migration",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: "All migration work is complete.",
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved).toMatchObject({
      status: "completed",
      current_focus_task: "",
      completion_decision: {
        next_action: "complete",
        ready_to_finish: true,
        reason: "All tasks are complete and there are no unresolved reply requests.",
      },
    });
    expect(saved?.agents.lead.status).toBe("done");
    expect(saved?.tasks.finish.status).toBe("completed");
  });
});
