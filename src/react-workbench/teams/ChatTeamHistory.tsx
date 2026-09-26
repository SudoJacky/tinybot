import { useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import { ChatTeamContext } from "./chatTeamContext";
import { chatTeamsApi } from "./useChatTeamRun";
import "./chatTeamCard.css";

/** A read-only index of durable runs, including runs made before Chat recruitment. */
export function ChatTeamHistory({ sessionId, loadRuns = chatTeamsApi.list }: {
  sessionId: string; loadRuns?: () => Promise<TeamRun[]>;
}) {
  const { t } = useTranslation("common");
  const inspector = useContext(ChatTeamContext);
  const details = useRef<HTMLDetailsElement>(null);
  const [runs, setRuns] = useState<TeamRun[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  async function refresh() {
    const id = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const items = await loadRuns();
      if (id === request.current) setRuns([...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch (cause) {
      if (id === request.current) setError(String(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  return <details ref={details} className="chat-team-history" onToggle={event => {
    if (event.currentTarget.open) void refresh();
    else request.current++;
  }}>
    <summary>{t("teams.recent")}</summary>
    {details.current?.open && <div className="chat-team-history__list">
      <button onClick={() => void refresh()} disabled={loading}>{t("teams.refresh")}</button>
      {loading && <p role="status">{t("teams.loading")}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !runs?.length && <p>{t("teams.empty")}</p>}
      {runs?.map(run => <button key={run.id} disabled={!inspector || !run.tasks.length}
        onClick={event => {
          inspector?.open(run, run.tasks[0].task.id, event.currentTarget);
          if (details.current) details.current.open = false;
        }}>
        <strong>{run.spec.goal}</strong>
        <small>{t(`teams.status.${run.status}`)} · {run.parentThreadId
          ? run.parentThreadId === sessionId ? t("teams.currentChatRun") : t("teams.otherChatRun")
          : t("teams.independentRun")}</small>
      </button>)}
    </div>}
  </details>;
}
