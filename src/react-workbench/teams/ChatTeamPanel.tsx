import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FileText, ListTodo, Pause, Play, Square, ChartNoAxesColumn } from "lucide-react";
import { createAgentTimelineModel } from "../../app-core/chat/agentTimelineModel";
import { createDesktopNativeThreadsApi } from "../../app-core/native/desktopNativeThreads";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { UsageDetailsLoader } from "../../app-core/settings/tokenUsage";
import type { PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";
import { UsageHistory } from "../settings/UsageBreakdown";
import { TeamFiles } from "./TeamFiles";
import { canExecute } from "./teamPresentation";
import { projectTeamActivity, type TeamActivity as Activity } from "./useTeamActivity";
import { TeamActivity, type TeamActivityView } from "./TeamActivity";
import { TeamMemberDock } from "./TeamMemberDock";
import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { TeamTaskStatus } from "./TeamTaskStatus";
import { TeamMessage } from "./TeamMessage";
import { TeamMainPlan } from "./TeamMainPlan";
import type { TimelinePlan } from "../chat/useChatTimelineSummary";
import teamWorkspaceIcon from "./assets/team-workspace.png";
import "./teams.css";
import "./chatTeamCard.css";

const threads = createDesktopNativeThreadsApi();
export async function readChatTeamAttempt(threadId: string, turnId: string) {
  const payload = await threads.getTurnRuntimeState(threadId, turnId);
  return projectTeamActivity(createAgentTimelineModel().load(threadId, [payload]), turnId);
}
/** Team content inside the shared Sidecar shell; it owns no panel geometry. */
export function ChatTeamPanel({ run, taskId, mainPlan, workspaceStore, loadAttempt, loadUsageDetails, error, controlError, busy, pending, onRefresh, onClose, onSelect, onExecute, onControl }: {
  run: TeamRun; taskId: string; workspaceStore: PreviewWorkspaceStore;
  mainPlan?: TimelinePlan;
  loadAttempt: typeof readChatTeamAttempt; loadUsageDetails?: UsageDetailsLoader;
  error?: string; controlError?: string; busy: boolean; pending?: "start" | "pause" | "cancel";
  onRefresh(): void; onClose(): void; onSelect(id: string): void; onExecute(): void;
  onControl(action: "pause" | "cancel" | "retry", taskIds?: string[]): Promise<void>;
}) {
  const { t } = useTranslation("common");
  const { t: usageText } = useTranslation("settings");
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const restoredPosition = useRef<string | undefined>(undefined);
  const views = useRef(new Map<string, TeamActivityView>());
  const [tab, setTab] = useState<"tasks" | "files" | "usage">("tasks");
  const [selectedAttempt, setSelectedAttempt] = useState<{ taskId: string; threadId: string }>();
  const record = run.tasks.find(value => value.task.id === taskId)!;
  const member = run.spec.members.find(value => value.id === record.task.memberId)!;
  const attempt = record.attempts.find(value => selectedAttempt?.taskId === taskId && value.threadId === selectedAttempt.threadId)
    ?? record.attempts.slice(-1)[0];
  const threadId = attempt?.threadId;
  const turnId = attempt?.turnId;
  const status = attempt?.status;
  const activityKey = `${run.id}/${taskId}/${threadId ?? "pending"}/${turnId ?? "pending"}`;
  const [loaded, setLoaded] = useState<{ key: string; activity: Activity }>();
  const activity = loaded?.key === activityKey ? loaded.activity : undefined;
  const [epoch, setEpoch] = useState(0);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
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
    setTab("tasks");
    setSelectedAttempt(undefined);
    onSelect(id);
  }
  function openAttempt(thread: string) {
    const owner = run.tasks.find(value => value.attempts.some(value => value.threadId === thread));
    if (!owner) return;
    if (scroll.current) positions.current.set(activityKey, scroll.current.scrollTop);
    setTab("tasks");
    setSelectedAttempt({ taskId: owner.task.id, threadId: thread });
    if (owner.task.id !== taskId) onSelect(owner.task.id);
  }
  return <section ref={panel} tabIndex={-1} className="chat-team-inspector team-layout" aria-label={t("teams.teamWorkspace")}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
    <header className="chat-team-inspector__header">
      <div className="chat-team-inspector__identity">
        <img src={teamWorkspaceIcon} alt="" className="chat-team-inspector__icon" />
        <div><h2>{t("teams.teamWorkspace")}</h2><p role="status">{t(`teams.status.${run.status}`)}</p></div>
      </div>
      <div className="chat-team-inspector__controls">
        {run.status === "running" ? <>
          <button disabled={busy || !!pending} onClick={() => void onControl("pause")}><Pause size={15} aria-hidden="true" />{t("teams.pause")}</button>
          <button disabled={busy || pending === "cancel"} onClick={() => void onControl("cancel")}><Square size={14} aria-hidden="true" />{t("teams.stop")}</button>
        </> : canExecute(run) ? <button disabled={busy || pending === "start"} onClick={onExecute}>
          <Play size={15} aria-hidden="true" />{run.status === "planned" ? t("teams.start") : t("teams.resume")}
        </button> : null}
        <div className="chat-team-inspector__tabs" role="tablist" aria-label={t("teams.details")}>
          <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}><ListTodo size={16} aria-hidden="true" />{t("teams.tasks")}</button>
          <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}><FileText size={16} aria-hidden="true" />{t("teams.files")}</button>
          <button role="tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}><ChartNoAxesColumn size={16} aria-hidden="true" />{usageText("usage.tab")}</button>
        </div>
      </div>
      {mainPlan && <TeamMainPlan key={mainPlan.identityKey} plan={mainPlan.plan} />}
    </header>
    {pending && <p className="chat-team-inspector__notice" role="status">{t(`teams.${pending === "start" ? "loading" : pending === "pause" ? "pausing" : "cancelling"}`)}</p>}
    {controlError && <p className="chat-team-inspector__notice team-error" role="alert">{controlError}</p>}
    <div className="chat-team-inspector__scroll" ref={scroll} onScroll={event => {
      if (restoredPosition.current === activityKey) positions.current.set(activityKey, event.currentTarget.scrollTop);
    }}>
      {error && <p role="alert">{error} <button onClick={onRefresh}>{t("teams.refresh")}</button></p>}
      {run.error && <p role="alert">{run.error}</p>}
      {tab === "files" ? <TeamFiles run={run} workspaceStore={workspaceStore} onSelectTask={select} onOpenThread={openAttempt} />
        : tab === "usage" ? loadUsageDetails
          ? <UsageHistory key={run.id} load={loadUsageDetails} teamRunId={run.id} tasks={Object.fromEntries(run.tasks.map(value => [value.task.id, value.task.title]))} />
          : <p>{usageText("profile.unavailable")}</p>
        : <>
      <details className="team-assignment" key={taskId}>
        <summary className="team-worker-heading">
          <TeamMemberAvatar memberId={member.id} />
          <span className="team-worker-heading__text"><strong>{member.displayName}</strong><span>{record.task.title}</span></span>
          <TeamTaskStatus run={run} record={record} animate={false} />
          <span className="team-assignment__label">{t("teams.assignment")}<ChevronDown size={15} aria-hidden="true" /></span>
        </summary>
        <div className="team-assignment__content">
          <h3>{t("teams.role")}</h3><p>{member.instructions}</p><h3>{t("teams.instructions")}</h3><p>{record.task.instructions}</p>
          <h3>{t("teams.toolProfile")}: {t(`teams.toolProfiles.${member.toolProfile ?? "execution"}`)}</h3>
          <p>{t(`teams.toolProfileHints.${member.toolProfile ?? "execution"}`)}</p><p>{t("teams.employeeHandoffOnly")}</p>
          <h3>{t("teams.dependencies")}</h3>
          {record.task.dependencies.length ? record.task.dependencies.map(id => <button key={id} onClick={() => select(id)}>{run.tasks.find(r => r.task.id === id)!.task.title}</button>) : <p>{t("teams.noDependencies")}</p>}
        </div>
      </details>
      {["failed", "interrupted", "cancelled"].includes(record.status) && run.status !== "running" &&
        <div><p>{t("teams.retryHint")}</p><button disabled={busy} onClick={() => void onControl("retry", [record.task.id])}>{t("teams.retry")}</button></div>}
      {run.tasks.filter(r => r.task.memberId === member.id).length > 1 && <div className="chat-team-inspector__assignments">
        {run.tasks.filter(r => r.task.memberId === member.id).map(r => <button key={r.task.id} aria-pressed={taskId === r.task.id} onClick={() => select(r.task.id)}>{r.task.title}</button>)}
      </div>}
      {record.attempts.length > 1 && <div className="chat-team-inspector__attempts" aria-label={t("teams.earlierAttempts", { count: record.attempts.length - 1 })}>
        {record.attempts.map((value, index) => <button key={value.threadId} aria-pressed={attempt?.threadId === value.threadId}
          onClick={() => openAttempt(value.threadId)}>{t("teams.attemptNumber", { number: index + 1 })} · {t(`teams.status.${value.status}`)}</button>)}
      </div>}
      {attempt ? <TeamActivity key={attempt.threadId} activity={activity} onRefresh={() => setEpoch(n => n + 1)} threadId={attempt.threadId}
        workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} savedView={views.current.get(attempt.threadId)} onViewChange={view => views.current.set(attempt.threadId, view)} /> : <p>{t("teams.noActivity")}</p>}
      {attempt?.output && <section className="chat-team-inspector__output"><h3>{t("teams.output")}</h3><TeamMessage key={attempt.threadId} runId={run.id} attempt={attempt} workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} /></section>}
      {attempt?.error && <p className="team-error" role="alert">{attempt.error}</p>}
      </>}
    </div>
    <TeamMemberDock run={run} selectedMemberId={member.id} onSelect={select} />
  </section>;
}
