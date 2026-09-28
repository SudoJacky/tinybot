import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStep } from "../../app-core/chat/chatTurnContracts";

export type TeamActivityItem = Pick<ChatStep,
  "id" | "kind" | "status" | "summary" | "toolCall" | "plan" | "artifacts" | "startedAt" | "completedAt"
> & { text: string };
export type TeamActivity = { items: TeamActivityItem[]; loading: boolean; error?: string };

export function projectTeamActivity(snapshot: ChatTimelineSnapshot, turnId: string): TeamActivityItem[] {
  const turn = snapshot.turns.find((item) => item.id === turnId);
  // Preserve recorded execution details; never synthesize activity or include user input.
  return (turn?.steps ?? []).filter((step) =>
    ["reasoning", "message", "tool_call", "plan", "delegate", "error"].includes(step.kind),
  ).map((step) => ({
    id: step.id,
    kind: step.kind,
    text: (step.kind === "tool_call" ? step.toolCall?.name ?? step.title
      : step.kind === "message" || step.kind === "reasoning" ? step.summary ?? ""
      : step.kind === "plan" ? step.plan?.currentStep || step.title
      : step.title),
    status: step.status,
    summary: step.summary,
    toolCall: step.toolCall,
    plan: step.plan,
    artifacts: step.artifacts,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  }));
}
