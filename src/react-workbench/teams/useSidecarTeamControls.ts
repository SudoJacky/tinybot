import { useEffect, useRef, useState } from "react";
import type { TeamRun, TeamStore } from "../../app-core/native/desktopNativeTeams";
import { canExecute } from "./teamPresentation";

type ControlState = { busy?: boolean; pending?: "start" | "pause" | "cancel"; error?: string };

// Native execute resolves only when the run stops. Its lifetime must not lock
// pause and cancel requests while workers are running.
export function useSidecarTeamControls(run: TeamRun | undefined, store: TeamStore, accept: (run: TeamRun) => void, refresh: () => void) {
  const [states, setStates] = useState<Record<string, ControlState>>({});
  const controlLocks = useRef(new Set<string>());
  const executing = useRef(new Set<string>());
  const runRef = useRef(run);
  runRef.current = run;
  const state = run ? states[run.id] : undefined;
  function update(id: string, patch: Partial<ControlState>) {
    setStates(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  }

  useEffect(() => {
    if (!run) return;
    const id = run.id;
    setStates(previous => {
      const current = previous[id];
      if (!current?.pending) return previous;
      if ((run.status === "running" && current.pending === "start")
        || (run.status !== "running" && current.pending !== "start")) {
        return { ...previous, [id]: { ...current, pending: undefined } };
      }
      return previous;
    });
  }, [run]);

  function execute() {
    const current = runRef.current;
    if (!current || !canExecute(current) || executing.current.has(current.id)) return;
    executing.current.add(current.id);
    update(current.id, { error: undefined, pending: "start" });
    void store.execute({ runId: current.id, expectedRevision: current.revision })
      .then(accept)
      .catch(cause => {
        update(current.id, { error: String(cause) });
        if (runRef.current?.id === current.id) refresh();
      })
      .finally(() => {
        executing.current.delete(current.id);
        setStates(previous => previous[current.id]?.pending === "start"
          ? { ...previous, [current.id]: { ...previous[current.id], pending: undefined } } : previous);
      });
  }

  async function control(action: "pause" | "cancel" | "retry", taskIds?: string[]) {
    const current = runRef.current;
    if (!current || controlLocks.current.has(current.id)) return;
    const pending = states[current.id]?.pending;
    if (action === "pause" && (current.status !== "running" || pending === "pause" || pending === "cancel")) return;
    if (action === "cancel" && (current.status === "completed" || current.status === "cancelled" || pending === "cancel")) return;
    if (action === "retry" && (current.status === "running" || !taskIds?.length || taskIds.some(id =>
      !current.tasks.some(record => record.task.id === id && ["failed", "interrupted", "cancelled"].includes(record.status))))) return;
    controlLocks.current.add(current.id);
    update(current.id, { busy: true, error: undefined });
    try {
      const next = await store.control({ runId: current.id, expectedRevision: current.revision, action, taskIds });
      accept(next);
      const visible = runRef.current;
      // A poll can observe the terminal transition before the control call returns.
      // Do not revive its pending label from an older "running" response.
      const superseded = visible?.id === next.id && (visible.revision > next.revision
        || (visible.revision === next.revision && visible.status !== "running"));
      if (next.status === "running" && action !== "retry" && !superseded) update(current.id, { pending: action });
    } catch (cause) {
      update(current.id, { error: String(cause) });
      if (runRef.current?.id === current.id) refresh();
    } finally {
      controlLocks.current.delete(current.id);
      update(current.id, { busy: false });
    }
  }

  return { busy: !!state?.busy, pending: state?.pending, error: state?.error, execute, control };
}
