import { useEffect, useRef, useState } from "react";
import type {
  TeamRun,
  TeamStore,
} from "../../app-core/native/desktopNativeTeams";
import { acceptRevision } from "./teamPresentation";

// Native execution resolves at completion; polling and controls have separate lifetimes.
export function useTeamRuns(store: TeamStore) {
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [pending, setPending] = useState<
    Record<string, "pause" | "cancel" | "start">
  >({});
  const mounted = useRef(false);
  const lock = useRef(false);
  const snapshots = useRef<TeamRun[]>([]);
  const executions = useRef(new Set<string>());

  function accept(run: TeamRun) {
    if (!mounted.current) return;
    if (
      snapshots.current.some(
        (old) => old.id === run.id && old.revision > run.revision,
      )
    )
      return;
    snapshots.current = acceptRevision(snapshots.current, run);
    setRuns(snapshots.current);
    setPending((previous) => {
      if (
        (previous[run.id] === "start" &&
          ["planned", "paused", "interrupted"].includes(run.status)) ||
        (previous[run.id] !== "start" && run.status === "running")
      )
        return previous;
      const next = { ...previous };
      delete next[run.id];
      return next;
    });
  }
  function fail(e: unknown) {
    if (mounted.current) setError(String(e));
  }
  async function refresh() {
    setError(null);
    setLoading(true);
    try {
      const values = await store.list();
      values.forEach(accept);
    } catch (e) {
      fail(e);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshEpoch((value) => value + 1);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [store]);
  const run = runs.find((value) => value.id === selectedId) ?? null;
  const polling =
    run?.status === "running" ||
    (selectedId !== null && pending[selectedId] === "start");
  useEffect(() => {
    if (!selectedId || !polling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await store.get(selectedId!);
        if (active) {
          accept(value);
          timer = setTimeout(() => void poll(), 1500);
        }
      } catch (e) {
        if (active) fail(e);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selectedId, polling, store, refreshEpoch]);
  async function action(work: () => Promise<TeamRun>, select = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await work();
      accept(value);
      if (select && mounted.current) setSelectedId(value.id);
      return value;
    } catch (e) {
      fail(e);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function execute(value: TeamRun) {
    if (executions.current.has(value.id)) return;
    executions.current.add(value.id);
    setError(null);
    setPending((previous) => ({ ...previous, [value.id]: "start" }));
    void store
      .execute({ runId: value.id, expectedRevision: value.revision })
      .then(accept)
      .catch(fail)
      .finally(() => {
        executions.current.delete(value.id);
        if (mounted.current)
          setPending((previous) => {
            const next = { ...previous };
            delete next[value.id];
            return next;
          });
      });
  }
  async function control(
    actionName: "pause" | "cancel" | "retry",
    taskIds?: string[],
  ) {
    if (!run) return;
    const result = await action(() =>
      store.control({
        runId: run.id,
        expectedRevision: run.revision,
        action: actionName,
        taskIds,
      }),
    );
    if (
      result?.status === "running" &&
      actionName !== "retry" &&
      snapshots.current.find((value) => value.id === result.id)?.status ===
        "running"
    )
      setPending((previous) => ({ ...previous, [result.id]: actionName }));
  }
  return {
    runs,
    run,
    selectedId,
    setSelectedId,
    error,
    loading,
    busy,
    pending: run ? pending[run.id] : undefined,
    refresh,
    action,
    execute,
    control,
  };
}
