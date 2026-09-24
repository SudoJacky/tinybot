import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallState } from "../../app-core/chat/chatTurnContracts";
import { createAgentTimelineModel } from "../../app-core/chat/agentTimelineModel";
import { createDesktopNativeTeamsApi, type TeamRun } from "../../app-core/native/desktopNativeTeams";
import { createDesktopNativeThreadsApi } from "../../app-core/native/desktopNativeThreads";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { projectTeamActivity, type TeamActivityItem } from "./useTeamActivity";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import "./chatTeamCard.css";

const teams = createDesktopNativeTeamsApi();
const threads = createDesktopNativeThreadsApi();

export function recruitedRunId(tool: ToolCallState): string | undefined {
  if (tool.name !== "team.recruit") return;
  const queue: unknown[] = [tool.resultJson];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const value = queue[i];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.runId === "string" && Array.isArray(record.tasks)) return record.runId;
    queue.push(record.raw, record.result, record.executor);
  }
}

async function readAttempt(threadId: string, turnId: string): Promise<TeamActivityItem[]> {
  const payload = await threads.getTurnRuntimeState(threadId, turnId);
  return projectTeamActivity(createAgentTimelineModel().load(threadId, [payload]), turnId);
}

/** Opening Chat reads no Team files. Expanding this card loads only its board. */
export function ChatTeamCard({ runId, loadRun = teams.get, loadAttempt = readAttempt }: {
  runId: string;
  loadRun?: (id: string) => Promise<TeamRun>;
  loadAttempt?: (threadId: string, turnId: string) => Promise<TeamActivityItem[]>;
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<TeamRun>();
  const [selected, setSelected] = useState<string>();
  const [items, setItems] = useState<TeamActivityItem[]>([]);
  const [error, setError] = useState<string>();
  const [workerError, setWorkerError] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(40);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await loadRun(runId);
        if (disposed) return;
        setRun(next);
        setError(undefined);
        if (next.status === "running") timer = setTimeout(() => void refresh(), 2000);
      } catch (e) { if (!disposed) setError(String(e)); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open, runId, loadRun, epoch]);
  const record = run?.tasks.find((task) => task.task.id === selected);
  const attempt = record?.attempts.slice(-1)[0];
  const member = run?.spec.members.find((value) => value.id === record?.task.memberId);
  const threadId = attempt?.threadId;
  const turnId = attempt?.turnId;
  const attemptStatus = attempt?.status;
  useEffect(() => {
    setItems([]);
    setWorkerError(undefined);
    setVisibleCount(40);
    if (!open || !threadId || !turnId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const targetThread = threadId;
    const targetTurn = turnId;
    async function refresh() {
      try {
        const next = await loadAttempt(targetThread, targetTurn);
        if (disposed) return;
        setItems(next);
        setWorkerError(undefined);
        if (attemptStatus === "running") timer = setTimeout(() => void refresh(), 2000);
      } catch (e) { if (!disposed) setWorkerError(String(e)); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open, threadId, turnId, attemptStatus, loadAttempt, epoch]);
  return <details className="chat-team-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("routes.teams")}{run ? ` · ${run.tasks.filter((r) => r.status === "succeeded").length}/${run.tasks.length}` : ""}</summary>
    {open && <div className="chat-team-card__body">
      {error && <p role="alert">{error} <button onClick={() => setEpoch((value) => value + 1)}>{t("teams.refresh")}</button></p>}
      {!run && !error && <p role="status">{t("teams.loading")}</p>}
      {run && <>
        <p>{run.spec.goal} · {t(`teams.status.${run.status}`)}</p>
        {run.error && <p role="alert">{run.error}</p>}
        <div className="chat-team-card__employees">
          {run.tasks.map(({ task, status }) => {
            const employee = run.spec.members.find((value) => value.id === task.memberId)!;
            return <button key={task.id} aria-pressed={selected === task.id} onClick={() => setSelected(task.id)}>
              <TeamMemberAvatar memberId={employee.id} />
              <span><strong>{employee.displayName}</strong><small>{task.title}</small></span>
              <small>{t(`teams.status.${status}`)}</small>
            </button>;
          })}
        </div>
        {record && <section aria-label={record.task.title}>
          <h4>{record.task.title}</h4>
          <details><summary>{member?.displayName}</summary><p className="chat-team-card__instructions">{member?.instructions}</p><p className="chat-team-card__instructions">{record.task.instructions}</p></details>
          {attempt?.message && <AssistantMarkdown text={attempt.message.summary} streaming={false} />}
          {attempt?.message?.unresolved && <p>{attempt.message.unresolved}</p>}
          {attempt?.error && <p role="alert">{attempt.error}</p>}
          {workerError && <p role="alert">{workerError} <button onClick={() => setEpoch((value) => value + 1)}>{t("teams.refresh")}</button></p>}
          {items.length > visibleCount && <button onClick={() => setVisibleCount((count) => count + 40)}>{t("teams.loadEarlierActivity")}</button>}
          {items.slice(-visibleCount).map((item) => item.kind === "message"
            ? <AssistantMarkdown key={item.id} text={item.text} streaming={item.status === "running"} />
            : <p key={item.id}><small>{item.text}</small></p>)}
        </section>}
      </>}
    </div>}
  </details>;
}
