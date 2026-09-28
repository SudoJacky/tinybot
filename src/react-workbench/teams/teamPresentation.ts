import type {
  TeamRun,
  TeamTaskRecord,
} from "../../app-core/native/desktopNativeTeams";

export function orderedTasks(tasks: TeamTaskRecord[]): TeamTaskRecord[] {
  const result: TeamTaskRecord[] = [];
  const seen = new Set<string>();
  while (result.length < tasks.length) {
    const next = tasks.find(
      ({ task }) =>
        !seen.has(task.id) && task.dependencies.every((id) => seen.has(id)),
    );
    if (!next) throw new Error("Invalid Team dependency graph");
    result.push(next);
    seen.add(next.task.id);
  }
  return result;
}
export function taskState(run: TeamRun, record: TeamTaskRecord) {
  if (record.status !== "pending") return record.status;
  if (run.status === "planned") return "planned";
  if (run.status === "paused" || run.status === "interrupted") return "paused";
  if (run.status !== "running") return "unexecuted";
  return record.task.dependencies.every(
    (id) => run.tasks.find((r) => r.task.id === id)?.status === "succeeded",
  )
    ? "queued"
    : "blocked";
}
export function memberTask(run: TeamRun, memberId: string) {
  const tasks = run.tasks.filter((record) => record.task.memberId === memberId);
  return tasks.find((record) => record.status === "running")
    ?? tasks.filter((record) => record.attempts.length).sort((a, b) =>
      b.attempts.slice(-1)[0]!.startedAt.localeCompare(a.attempts.slice(-1)[0]!.startedAt),
    )[0]
    ?? orderedTasks(run.tasks).find((record) => record.task.memberId === memberId);
}

export function canExecute(run: TeamRun) {
  return (
    ["planned", "paused", "interrupted"].includes(run.status) &&
    run.tasks.every((r) => ["pending", "succeeded"].includes(r.status))
  );
}
