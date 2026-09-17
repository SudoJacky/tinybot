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
export function acceptRevision(runs: TeamRun[], incoming: TeamRun): TeamRun[] {
  const previous = runs.find((run) => run.id === incoming.id);
  if (previous && previous.revision > incoming.revision) return runs;
  return [incoming, ...runs.filter((run) => run.id !== incoming.id)].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );
}
export function canExecute(run: TeamRun) {
  return (
    ["planned", "paused", "interrupted"].includes(run.status) &&
    run.tasks.every((r) => ["pending", "succeeded"].includes(r.status))
  );
}
