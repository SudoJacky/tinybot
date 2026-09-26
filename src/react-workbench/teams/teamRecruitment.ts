import type { ChatStepStatus, ToolCallState } from "../../app-core/chat/chatTurnContracts";

export type RecruitmentBatch = {
  memberIds: string[];
  tasks: Array<{ taskId: string; memberId: string }>;
};
export type TeamRecruitment =
  | { kind: "batch"; runId: string; batch: RecruitmentBatch }
  | { kind: "legacy"; runId: string }
  | { kind: "invalid" };

/** Full canonical arguments own the batch; the cumulative result only confirms it. */
export function teamRecruitment(tool: ToolCallState, status: ChatStepStatus): TeamRecruitment | undefined {
  if (tool.name !== "team.recruit" || status !== "completed") return;
  const snapshot = recruitmentSnapshot(tool.resultJson);
  if (!snapshot || !identifier(snapshot.runId) || !Array.isArray(snapshot.tasks) || !snapshot.tasks.length) return { kind: "invalid" };
  const confirmed = new Map<string, string>();
  for (const task of snapshot.tasks) {
    if (!record(task) || !identifier(task.taskId) || !identifier(task.memberId) || confirmed.has(task.taskId)) return { kind: "invalid" };
    confirmed.set(task.taskId, task.memberId);
  }
  // Older saved calls may retain the result without the original arguments.
  if (tool.argsJson == null) return { kind: "legacy", runId: snapshot.runId };
  const args = tool.argsJson;
  if (!record(args) || !Array.isArray(args.tasks) || !args.tasks.length || !Array.isArray(args.members)
    || (args.runId != null && args.runId !== snapshot.runId)) return { kind: "invalid" };
  const memberIds = new Set<string>();
  for (const member of args.members) {
    if (!record(member) || !identifier(member.id) || memberIds.has(member.id)) return { kind: "invalid" };
    memberIds.add(member.id);
  }
  const taskIds = new Set<string>();
  const tasks: RecruitmentBatch["tasks"] = [];
  for (const task of args.tasks) {
    if (!record(task) || !identifier(task.id) || !identifier(task.memberId)
      || taskIds.has(task.id) || confirmed.get(task.id) !== task.memberId) return { kind: "invalid" };
    taskIds.add(task.id);
    memberIds.add(task.memberId);
    tasks.push({ taskId: task.id, memberId: task.memberId });
  }
  return { kind: "batch", runId: snapshot.runId, batch: { memberIds: [...memberIds], tasks } };
}

function recruitmentSnapshot(result: unknown): Record<string, unknown> | undefined {
  const queue = [result];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const value = queue[i];
    if (!record(value)) continue;
    if (value.status === "error" || value.status === "denied" || value.isError === true || value.truncated === true) return;
    if ("runId" in value) return value;
    queue.push(value.raw, value.result, value.executor);
  }
}

function identifier(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
