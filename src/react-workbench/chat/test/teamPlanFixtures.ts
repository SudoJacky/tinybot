import { createAgentTimelineModel } from "../../../app-core/chat/agentTimelineModel";
import type { PlanState } from "../../../app-core/chat/chatTurnContracts";
import type { TeamRun } from "../../../app-core/native/desktopNativeTeams";
import { recruitmentRuntime } from "./teamRecruitmentFixtures";

export const mainPlan: PlanState = {
  completed: 1, total: 4, currentStep: "Compare the designs",
  explanation: "Use original evidence and verify the recommendations before the final answer.",
  steps: [
    { step: "Collect original sources", status: "completed" },
    { step: "Compare the designs", status: "in_progress" },
    { step: "Validate permissions and recovery", status: "pending" },
    { step: "Deliver the final recommendation", status: "pending" },
  ],
};

/** Load the same durable canonical path used when a Chat is opened or reloaded. */
export function teamPlanTimeline(run: TeamRun, plan: PlanState | null = mainPlan,
  status = "running", revision = 1, batches?: string[][]) {
  const recruitment = recruitmentRuntime(run, batches);
  const source = recruitment.timeline;
  const payload = { ...recruitment, status, timeline: { ...source, snapshotRevision: revision,
    items: [...source.items, ...(plan ? [{
      schemaVersion: "tinybot.turn_item.v2", itemId: "main-plan", sessionId: source.sessionId, turnId: source.turnId,
      sequence: source.items.length + 1, revision, kind: "plan_progress", title: "Execution plan", status: "running",
      createdAt: "2026-09-26T06:00:00Z",
      data: { type: "plan_progress", ...plan },
    }] : [])],
  } };
  const earlier = { status: "completed", timeline: { schemaVersion: "tinybot.timeline.v2", sessionId: source.sessionId,
    turnId: "earlier-report", snapshotRevision: 1, items: [{
      schemaVersion: "tinybot.turn_item.v2", itemId: "report-link", sessionId: source.sessionId, turnId: "earlier-report",
      sequence: 1, revision: 1, kind: "assistant_message", status: "completed", createdAt: "2026-09-26T05:00:00Z",
      data: { type: "assistant_message", phase: "final_answer", modelCallId: "earlier-call", content: "Review the [research report](report.md)." },
    }],
  } };
  return createAgentTimelineModel().load(source.sessionId, JSON.parse(JSON.stringify([earlier, payload])));
}
