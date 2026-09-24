import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { createAgentTimelineModel } from "../../app-core/chat/agentTimelineModel";
import { createDesktopNativeThreadsApi } from "../../app-core/native/desktopNativeThreads";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";
import { ChatTeamContext } from "./chatTeamContext";
import { useChatTeamRun, chatTeamsApi } from "./useChatTeamRun";
import { projectTeamActivity, type TeamActivity as Activity } from "./useTeamActivity";
import { TeamActivity, type TeamActivityView } from "./TeamActivity";
import { TeamMemberDock } from "./TeamMemberDock";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { TeamTaskStatus } from "./TeamTaskStatus";
import { TeamMessage } from "./TeamMessage";
import "./teams.css";
import "./chatTeamCard.css";

const threads = createDesktopNativeThreadsApi();
export async function readChatTeamAttempt(threadId: string, turnId: string) {
  const payload = await threads.getTurnRuntimeState(threadId, turnId);
  return projectTeamActivity(createAgentTimelineModel().load(threadId, [payload]), turnId);
}
type Selection = { sessionId: string; run: TeamRun; taskId: string; trigger: HTMLButtonElement };

export function ChatTeamWorkspace({ sessionId, workspaceStore, sidecarPresentation, onHideSidecar,
  children, loadRun = chatTeamsApi.get, loadAttempt = readChatTeamAttempt, ...props }: ComponentProps<"div"> & {
  sessionId: string; workspaceStore?: PreviewWorkspaceStore;
  sidecarPresentation: string; onHideSidecar(): void;
  loadRun?: typeof chatTeamsApi.get; loadAttempt?: typeof readChatTeamAttempt;
}) {
  const [selection, setSelection] = useState<Selection>();
  const active = selection?.sessionId === sessionId ? selection : undefined;
  const board = useChatTeamRun(active?.run.id ?? "", !!active, loadRun);
  const run = board.run ?? active?.run;
  function close() {
    const trigger = active?.trigger;
    setSelection(undefined);
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  // A newly opened Browser/Artifact takes the right panel back; switching Chat clears inspection.
  useEffect(() => { setSelection(undefined); }, [sessionId]);
  useEffect(() => { if (sidecarPresentation !== "closed") setSelection(undefined); }, [sidecarPresentation]);
  return <ChatTeamContext.Provider value={workspaceStore ? { run, selectedTaskId: active?.taskId,
    open: (next, taskId, trigger) => {
      if (sidecarPresentation !== "closed") onHideSidecar();
      setSelection({ sessionId, run: next, taskId, trigger });
    },
  } : null}>
    <div {...props} data-team-open={active ? "true" : undefined}>
      {children}
      {active && run && workspaceStore && <ChatTeamInspector key={run.id} run={run} taskId={active.taskId}
        workspaceStore={workspaceStore} loadAttempt={loadAttempt} error={board.error} onRefresh={board.refresh}
        onClose={close} onSelect={taskId => setSelection({ ...active, taskId })} />}
    </div>
  </ChatTeamContext.Provider>;
}

function ChatTeamInspector({ run, taskId, workspaceStore, loadAttempt, error, onRefresh, onClose, onSelect }: {
  run: TeamRun; taskId: string; workspaceStore: PreviewWorkspaceStore;
  loadAttempt: typeof readChatTeamAttempt; error?: string; onRefresh(): void; onClose(): void; onSelect(id: string): void;
}) {
  const { t } = useTranslation("common");
  const closeButton = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const restoredPosition = useRef<string | undefined>(undefined);
  const views = useRef(new Map<string, TeamActivityView>());
  const record = run.tasks.find(value => value.task.id === taskId)!;
  const member = run.spec.members.find(value => value.id === record.task.memberId)!;
  const attempt = record.attempts.slice(-1)[0];
  const threadId = attempt?.threadId;
  const turnId = attempt?.turnId;
  const status = attempt?.status;
  const activityKey = `${taskId}/${threadId ?? "pending"}/${turnId ?? "pending"}`;
  const [loaded, setLoaded] = useState<{ key: string; activity: Activity }>();
  const activity = loaded?.key === activityKey ? loaded.activity : undefined;
  const [epoch, setEpoch] = useState(0);
  const completed = run.tasks.filter(value => value.status === "succeeded").length;
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!threadId || !turnId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const targetThread = threadId, targetTurn = turnId;
    setLoaded({ key: activityKey, activity: { items: [], loading: true } });
    async function refresh() {
      try {
        const items = await loadAttempt(targetThread, targetTurn);
        if (disposed) return;
        setLoaded({ key: activityKey, activity: { items, loading: false } });
        if (status === "running") timer = setTimeout(() => void refresh(), 2000);
      } catch (cause) {
        if (!disposed) setLoaded(previous => ({ key: activityKey, activity: {
          items: previous?.key === activityKey ? previous.activity.items : [], loading: false, error: String(cause),
        } }));
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [threadId, turnId, activityKey, status, loadAttempt, epoch]);
  useLayoutEffect(() => {
    if (restoredPosition.current === activityKey || (attempt && (!activity || activity.loading))) return;
    if (scroll.current) scroll.current.scrollTop = positions.current.get(activityKey) ?? 0;
    restoredPosition.current = activityKey;
  }, [activityKey, activity, attempt]);
  function select(id: string) {
    if (scroll.current) positions.current.set(activityKey, scroll.current.scrollTop);
    onSelect(id);
  }
  return <aside className="chat-team-inspector team-layout" aria-label={t("teams.teamWorkspace")}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
    <header className="chat-team-inspector__header">
      <div><strong>{t("teams.teamWorkspace")}</strong><p role="status">{t("teams.completedCount", { done: completed, total: run.tasks.length })} · {t(`teams.status.${run.status}`)}</p></div>
      <button ref={closeButton} aria-label={t("teams.backToChat")} title={t("teams.backToChat")} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="team-completion-track" role="progressbar" aria-label={t("teams.progress")} aria-valuemin={0} aria-valuemax={run.tasks.length} aria-valuenow={completed}>
      <span style={{ transform: `scaleX(${run.tasks.length ? completed / run.tasks.length : 0})` }} />
    </div>
    <div className="chat-team-inspector__scroll" ref={scroll} onScroll={event => {
      if (restoredPosition.current === activityKey) positions.current.set(activityKey, event.currentTarget.scrollTop);
    }}>
      {error && <p role="alert">{error} <button onClick={onRefresh}>{t("teams.refresh")}</button></p>}
      {run.error && <p role="alert">{run.error}</p>}
      <div className="team-worker-heading"><TeamMemberAvatar memberId={member.id} /><div><span>{member.displayName}</span><h2>{record.task.title}</h2></div></div>
      <TeamTaskStatus run={run} record={record} animate={false} />
      <details className="team-assignment" key={taskId}>
        <summary>{t("teams.assignment")}</summary><h3>{t("teams.role")}</h3><p>{member.instructions}</p><h3>{t("teams.instructions")}</h3><p>{record.task.instructions}</p>
        <h3>{t("teams.dependencies")}</h3>
        {record.task.dependencies.length ? record.task.dependencies.map(id => <button key={id} onClick={() => select(id)}>{run.tasks.find(r => r.task.id === id)!.task.title}</button>) : <p>{t("teams.noDependencies")}</p>}
      </details>
      {run.tasks.filter(r => r.task.memberId === member.id).length > 1 && <div className="chat-team-inspector__assignments">
        {run.tasks.filter(r => r.task.memberId === member.id).map(r => <button key={r.task.id} aria-pressed={taskId === r.task.id} onClick={() => select(r.task.id)}>{r.task.title}</button>)}
      </div>}
      {attempt ? <TeamActivity key={attempt.threadId} activity={activity} onRefresh={() => setEpoch(n => n + 1)} threadId={attempt.threadId}
        workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} savedView={views.current.get(attempt.threadId)} onViewChange={view => views.current.set(attempt.threadId, view)} /> : <p>{t("teams.noActivity")}</p>}
      {attempt?.output && <section><h3>{t("teams.output")}</h3><TeamMessage key={attempt.threadId} runId={run.id} attempt={attempt} workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} /></section>}
      {attempt?.error && <p className="team-error" role="alert">{attempt.error}</p>}
    </div>
    <TeamMemberDock run={run} selectedMemberId={member.id} onSelect={select} />
  </aside>;
}
