import { useEffect, useState } from "react";
import { createDesktopNativeTeamsApi, type TeamRun } from "../../app-core/native/desktopNativeTeams";
export const chatTeamsApi = createDesktopNativeTeamsApi();

export function useChatTeamRun(runId: string, enabled: boolean, load = chatTeamsApi.get) {
  const [value, setValue] = useState<TeamRun>();
  const [error, setError] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await load(runId);
        if (disposed) return;
        setValue(next); setError(undefined);
        // A Chat coordinator can recruit another wave into a completed run.
        // Keep visible boards fresh without rereading completed worker histories.
        timer = setTimeout(() => void refresh(), next.status === "running" ? 2000 : 5000);
      } catch (cause) { if (!disposed) setError(String(cause)); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId, enabled, load, epoch]);
  return { run: value?.id === runId ? value : undefined, error, refresh: () => setEpoch(n => n + 1) };
}
