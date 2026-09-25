import { useCallback, useEffect, useRef, useState } from "react";
import { createDesktopNativeTeamsApi, type TeamRun } from "../../app-core/native/desktopNativeTeams";
export const chatTeamsApi = createDesktopNativeTeamsApi();

export function useChatTeamRun(runId: string, enabled: boolean, load = chatTeamsApi.get) {
  const [value, setValue] = useState<TeamRun>();
  const [error, setError] = useState<{ runId: string; message: string }>();
  const [epoch, setEpoch] = useState(0);
  const latest = useRef<TeamRun | undefined>(undefined);
  const accept = useCallback((next: TeamRun) => {
    if (latest.current?.id === next.id && latest.current.revision > next.revision) return;
    latest.current = next;
    setValue(next);
    setError(current => current?.runId === next.id ? undefined : current);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await load(runId);
        if (disposed) return;
        accept(next);
        // A Chat coordinator can recruit another wave into a completed run.
        // Keep visible boards fresh without rereading completed worker histories.
        timer = setTimeout(() => void refresh(), next.status === "running" ? 2000 : 5000);
      } catch (cause) { if (!disposed) setError({ runId, message: String(cause) }); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId, enabled, load, epoch, accept]);
  return { run: value?.id === runId ? value : undefined, error: error?.runId === runId ? error.message : undefined,
    accept, refresh: () => setEpoch(n => n + 1) };
}
