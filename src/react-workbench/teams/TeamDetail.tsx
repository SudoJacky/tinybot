import { TeamMemberAvatar } from "./TeamMemberAvatar";
import { TeamMemberDock } from "./TeamMemberDock";
import { TeamTaskFeed } from "./TeamTaskFeed";
import type { PreviewWorkspaceStore } from "../sidecar/ResultFilePreview";
import { UsageHistory } from "../settings/UsageBreakdown";
import type { UsageDetailsLoader } from "../../app-core/settings/tokenUsage";
import { TeamMessage } from "./TeamMessage";
import { TeamPlanEditor } from "./TeamPlanEditor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  Pause,
  Play,
  Square,
} from "lucide-react";
import type {
  TeamPlan,
  TeamRun,
  TeamTaskRecord,
} from "../../app-core/native/desktopNativeTeams";
import { canExecute, orderedTasks, taskState } from "./teamPresentation";
import { TeamElapsedTime, TeamTaskStatus } from "./TeamTaskStatus";
import { TeamFiles } from "./TeamFiles";
import { TeamActivity, type TeamActivityView } from "./TeamActivity";
import { useTeamActivity, type TeamActivitySource } from "./useTeamActivity";

type Props = {
  workspaceStore: PreviewWorkspaceStore;
  activitySource?: TeamActivitySource;
  loadUsageDetails?: UsageDetailsLoader;
  run: TeamRun;
  busy: boolean;
  pending?: "start" | "pause" | "cancel";
  onEditingChange?(editing: boolean): void;
  onBack(): void;
  onExecute(): void;
  onControl(
    action: "pause" | "cancel" | "retry",
    ids?: string[],
  ): Promise<void>;
  onRevise(plan: TeamPlan): Promise<TeamRun | undefined>;
  onOpenThread(id: string): Promise<void>;
};
export function TeamDetail({
  workspaceStore,
  activitySource,
  loadUsageDetails,
  run,
  busy,
  pending,
  onEditingChange,
  onBack,
  onExecute,
  onControl,
  onRevise,
  onOpenThread,
}: Props) {
  const { t } = useTranslation("common");
  const { t: usageText } = useTranslation("settings");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("tasks");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const tasks = orderedTasks(run.tasks);
  const runningTasks = tasks.filter((r) => r.status === "running");
  const completedCount = tasks.filter((r) => r.status === "succeeded").length;
  const final = run.tasks.find((r) => r.task.id === run.finalTaskId);
  // Follow active work until the user explicitly chooses a task to inspect.
  const record = run.tasks.find((r) => r.task.id === selected) ?? runningTasks[0] ?? final ?? tasks[0];
  const latestAttempt = record.attempts.slice(-1)[0];
  const { activity, refresh: refreshActivity } = useTeamActivity(activitySource, run, record.task.id);
  const inspectorRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const activityViews = useRef(new Map<string, TeamActivityView>());
  const restoredPosition = useRef<string | null>(null);
  const scrollKey = `${run.id}/${record.task.id}/${latestAttempt?.threadId ?? "pending"}`;
  const memberTasks = tasks.filter((task) => task.task.memberId === record.task.memberId);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const backToTasksRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Only move keyboard focus when the compact layout hides the task list.
    if (inspectorOpen && backToTasksRef.current?.getClientRects().length) {
      backToTasksRef.current.focus({ preventScroll: true });
    }
  }, [record.task.id, inspectorOpen]);
  function selectTask(id: string) {
    setTab("tasks");
    setSelected(id);
    setInspectorOpen(true);
    requestAnimationFrame(() => selectedRowRef.current?.scrollIntoView({ block: "nearest" }));
  }
  const [draft, setDraft] = useState<{
    plan: TeamPlan;
    revision: number;
  } | null>(null);
  const editing = Boolean(draft);
  useLayoutEffect(() => {
    restoredPosition.current = null;
    if (tab !== "tasks" || editing) return;
    if (latestAttempt && activitySource?.readTimeline
      && (!activity[latestAttempt.threadId] || activity[latestAttempt.threadId].loading)) return;
    if (inspectorRef.current) {
      inspectorRef.current.scrollTop = scrollPositions.current.get(scrollKey) ?? 0;
      restoredPosition.current = scrollKey;
    }
  }, [scrollKey, tab, editing, latestAttempt, activity, activitySource]);
  function closeEditor() {
    setDraft(null);
    setError(null);
    requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  const [error, setError] = useState<string | null>(null);
  const result =
    final?.status === "succeeded" ? final.attempts.slice(-1)[0]?.output : null;
  const editable =
    run.status !== "running" && run.status !== "completed" && !pending;
  const disabled = busy || Boolean(pending) || Boolean(draft);
  function status(r: TeamTaskRecord) {
    return t(`teams.status.${taskState(run, r)}`);
  }
  async function openRecord(id: string) {
    setError(null);
    if (draft) {
      setError(t("teams.unsaved"));
      return;
    }
    try {
      await onOpenThread(id);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <p className="react-sr-only" role="status" aria-atomic="true">
        {t("teams.progressAnnouncement", {
          status: t(`teams.status.${run.status}`), done: completedCount,
          total: tasks.length, running: runningTasks.length,
        })}
      </p>
      <header className="team-run-header" data-editing={editing}>
        <div className="team-breadcrumb">
          <button disabled={busy || !!draft} onClick={onBack}>
            <ArrowLeft size={15} />
            {t("teams.home")}
          </button>
          <span title={run.spec.workspacePath}>
            <Folder size={16} />
            <span>{run.spec.workspacePath.split(/[\\/]/).filter(Boolean).slice(-1)[0]}</span>
          </span>
        </div>
        <div className="team-heading-actions">
          <h1 title={run.spec.goal}>{run.spec.goal}</h1>
          <div>
            <span className={`team-status is-${run.status}`}>
              {run.status === "running" && <span className="team-state-dot" aria-hidden="true" />}
              {t(`teams.status.${run.status}`)}
            </span>
            {run.status === "running" ? (
              <>
                <button
                  className="react-form-primary"
                  disabled={busy || !!pending}
                  onClick={() => void onControl("pause")}
                >
                  <Pause size={17} />
                  {t("teams.pause")}
                </button>
                <button
                  disabled={busy || pending === "cancel"}
                  onClick={() => void onControl("cancel")}
                >
                  <Square size={15} />
                  {t("teams.stop")}
                </button>
              </>
            ) : (
              canExecute(run) && (
                <button
                  className="react-form-primary"
                  disabled={disabled}
                  onClick={onExecute}
                >
                  <Play size={17} />
                  {run.status === "planned"
                    ? t("teams.start")
                    : t("teams.resume")}
                </button>
              )
            )}
          </div>
        </div>
        <details className="team-goal-details">
          <summary>{t("teams.fullGoal")}</summary>
          <p>{run.spec.goal}</p>
        </details>
        {run.status === "planned" && <p>{t("teams.planHint")}</p>}
        {pending && (
          <p role="status">
            {pending === "pause"
              ? t("teams.pausing")
              : pending === "cancel"
                ? t("teams.cancelling")
                : t("teams.loading")}
          </p>
        )}
        {run.error && (
          <p className="team-error" role="alert">
            {run.error}
          </p>
        )}
        {error && (
          <p className="team-error" role="alert">
            {error}
          </p>
        )}
      </header>
      <div className="team-task-toolbar">
        <div
          role="tablist"
          aria-label={t("teams.details")}
          onKeyDown={(event) => {
            if (editing) return;
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const tabs = ["tasks", "files", "board", "result", "usage"];
            const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1]
              : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
            setTab(next);
            event.currentTarget
              .querySelector<HTMLButtonElement>(
                `#team-${next}-tab`,
              )
              ?.focus();
          }}
        >
          <button
            role="tab"
            id="team-tasks-tab"
            tabIndex={tab === "tasks" ? 0 : -1}
            aria-controls="team-tasks-panel"
            aria-selected={tab === "tasks"}
            onClick={() => setTab("tasks")}
          >
            {t("teams.tasks")}
          </button>
          <button role="tab" id="team-files-tab" disabled={editing}
            tabIndex={tab === "files" ? 0 : -1} aria-controls="team-files-panel"
            aria-selected={tab === "files"} onClick={() => setTab("files")}>{t("teams.files")}</button>
          <button role="tab" id="team-board-tab" disabled={editing}
            tabIndex={tab === "board" ? 0 : -1} aria-controls="team-board-panel"
            aria-selected={tab === "board"} onClick={() => setTab("board")}>{t("teams.board")}</button>
          <button
            role="tab"
            id="team-result-tab"
            disabled={editing}
            tabIndex={tab === "result" ? 0 : -1}
            aria-controls="team-result-panel"
            aria-selected={tab === "result"}
            onClick={() => setTab("result")}
          >
            {t("teams.result")}
          </button>
          <button role="tab" id="team-usage-tab" disabled={editing}
            tabIndex={tab === "usage" ? 0 : -1} aria-controls="team-usage-panel"
            aria-selected={tab === "usage"} onClick={() => setTab("usage")}>{usageText("usage.tab")}</button>
        </div>
        <div className="team-task-progress">
          {runningTasks.length > 0 && (
            <button
              className="team-locate-running"
              onClick={() => {
                const index = runningTasks.findIndex((r) => r.task.id === record.task.id);
                selectTask(runningTasks[(index + 1) % runningTasks.length].task.id);
              }}
              title={t("teams.locateRunning")}
            >
              <span className="team-state-dot" aria-hidden="true" />
              {t("teams.runningCount", { count: runningTasks.length })}
            </button>
          )}
          <span>
          {t("teams.completedCount", {
            done: completedCount,
            total: tasks.length,
          })}
          </span>
        </div>
      </div>
      {editing && <p className="team-editing-notice" role="status">{t("teams.editingHint")}</p>}
      <div
        className="team-completion-track"
        role="progressbar"
        aria-label={t("teams.progress")}
        aria-valuemin={0}
        aria-valuemax={tasks.length}
        aria-valuenow={completedCount}
        aria-valuetext={t("teams.completedCount", { done: completedCount, total: tasks.length })}
      >
        <span style={{ transform: `scaleX(${completedCount / tasks.length})` }} />
      </div>
      <div
        className="team-workspace"
        data-view={tab !== "tasks" ? "result" : draft ? "editor" : inspectorOpen ? "detail" : "tasks"}
      >
        <section className="team-task-pane">
          {tab === "files" ? (
            <section role="tabpanel" id="team-files-panel" aria-labelledby="team-files-tab" className="team-result">
              <TeamFiles run={run} workspaceStore={workspaceStore} onSelectTask={selectTask} onOpenThread={(id) => void openRecord(id)} />
            </section>
          ) : tab === "usage" ? (
            <section role="tabpanel" id="team-usage-panel" aria-labelledby="team-usage-tab" className="team-result">
              {loadUsageDetails ? <UsageHistory key={run.id} load={loadUsageDetails} teamRunId={run.id} tasks={Object.fromEntries(run.tasks.map(r => [r.task.id, r.task.title]))} /> : <p>{usageText("profile.unavailable")}</p>}
            </section>
          ) : tab === "board" ? (
            <section role="tabpanel" id="team-board-panel" aria-labelledby="team-board-tab" className="team-result team-board">
              {tasks.flatMap(r => r.attempts.filter(a => a.status === "succeeded").map(a => ({ r, a })))
                .sort((a,b) => (a.a.message?.sequence ?? 0) - (b.a.message?.sequence ?? 0))
                .map(({r,a}) => <article key={a.threadId}>
                  <h2>{r.task.title}</h2>
                  <p>{run.spec.members.find(m => m.id === r.task.memberId)!.displayName} · {a.finishedAt && new Date(a.finishedAt).toLocaleString()}</p>
                  <TeamMessage runId={run.id} workspaceStore={workspaceStore} workspacePath={run.spec.workspacePath} attempt={a} />
                  <button onClick={() => void openRecord(a.threadId)}>{t("teams.openRecord")}</button>
                </article>)}
              {!tasks.some(r => r.attempts.some(a => a.status === "succeeded")) && <p>{t("teams.emptyBoard")}</p>}
            </section>
          ) : tab === "result" ? (
            <section
              role="tabpanel"
              id="team-result-panel"
              aria-labelledby="team-result-tab"
              className="team-result"
            >
              {result ? (
                <TeamMessage key={final!.attempts.slice(-1)[0]!.threadId} runId={run.id} workspaceStore={workspaceStore} workspacePath={run.spec.workspacePath} attempt={final!.attempts.slice(-1)[0]!} />
              ) : (
                <p>{t("teams.noResult")}</p>
              )}
            </section>
          ) : (
            <section
              role="tabpanel"
              id="team-tasks-panel"
              aria-labelledby="team-tasks-tab"
            >
              {draft ? (
                <TeamPlanEditor
                  plan={draft.plan}
                  run={run}
                  busy={busy}
                  onChange={(plan) => setDraft({ ...draft, plan })}
                  onSubmit={() => {
                    if (draft.revision !== run.revision) {
                      setError(t("teams.conflict"));
                      return;
                    }
                    void onRevise(draft.plan).then((value) => {
                      if (value) {
                        closeEditor();
                      }
                    });
                  }}
                  onDiscard={closeEditor}
                />
              ) : (
                <>
                  <TeamTaskFeed run={run} tasks={tasks} selectedTaskId={record.task.id}
                    selectedRef={selectedRowRef} activity={activity} onSelect={selectTask} />
                  {editable && (
                    <button
                      className="team-edit-button"
                      ref={editButtonRef}
                      disabled={busy}
                      onClick={() => {
                        setDraft({
                          revision: run.revision,
                          plan: {
                            finalTaskId: run.finalTaskId,
                            tasks: run.tasks.map((r) => ({
                              ...r.task,
                              dependencies: [...r.task.dependencies],
                            })),
                          },
                        });
                      }}
                    >
                      {t("teams.edit")}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </section>
        {tab === "tasks" && !draft && (
          <aside ref={inspectorRef} className="team-inspector" aria-label={t("teams.details")}
            onScroll={(event) => {
              if (restoredPosition.current === scrollKey) scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop);
            }}>
            <button
              ref={backToTasksRef}
              className="team-inspector-back"
              onClick={() => {
                setInspectorOpen(false);
                requestAnimationFrame(() => selectedRowRef.current?.focus());
              }}
            >
              <ArrowLeft size={16} />{t("teams.backToTasks")}
            </button>
            <div key={`heading-${record.task.id}`} className="team-worker-heading">
              <TeamMemberAvatar memberId={record.task.memberId} />
              <div><span>{run.spec.members.find((member) => member.id === record.task.memberId)!.displayName}</span>
                <h2>{record.task.title}</h2></div>
            </div>
            <div className="team-inspector-meta">
              <TeamTaskStatus run={run} record={record} animate={false} />
              {record.status === "running" && latestAttempt && <>
                <TeamElapsedTime key={latestAttempt.threadId} attempt={latestAttempt} />
                <button className="team-record-link" onClick={() => void openRecord(latestAttempt.threadId)}>
                  {t("teams.viewLiveRecord")}<ArrowRight size={15} />
                </button>
              </>}
            </div>
            {memberTasks.length > 1 && <details key={`member-${record.task.memberId}`} className="team-member-tasks" aria-label={t("teams.memberTasks", { count: memberTasks.length })}>
              <summary>{t("teams.memberTasks", { count: memberTasks.length })}</summary>
              {memberTasks.map((task) => <button key={task.task.id} aria-pressed={task.task.id === record.task.id}
                onClick={() => selectTask(task.task.id)}>{task.task.title}<TeamTaskStatus run={run} record={task} animate={false} /></button>)}
            </details>}
            {latestAttempt && activitySource?.readTimeline && <TeamActivity key={latestAttempt.threadId}
              activity={activity[latestAttempt.threadId]} onRefresh={refreshActivity}
              savedView={activityViews.current.get(latestAttempt.threadId)}
              onViewChange={(view) => activityViews.current.set(latestAttempt.threadId, view)}
              threadId={latestAttempt.threadId} workspacePath={run.spec.workspacePath} workspaceStore={workspaceStore} />}
            <details key={`assignment-${record.task.id}`} className="team-assignment" open={latestAttempt ? undefined : true}>
              <summary>{t("teams.assignment")}</summary>
              <section>
                <h3>{t("teams.instructions")}</h3>
                <p>{record.task.instructions}</p>
              </section>
              <section>
                <h3>{t("teams.dependencies")}</h3>
                {record.task.dependencies.length ? (
                  record.task.dependencies.map((id) => {
                    const dep = run.tasks.find((r) => r.task.id === id)!;
                    return (
                      <button
                        className="team-dependency"
                        key={id}
                        onClick={() => selectTask(id)}
                      >
                        <span>{dep.task.title}</span>
                        <ArrowRight size={17} />
                        <span>{status(dep)}</span>
                      </button>
                    );
                  })
                ) : (
                  <p>{t("teams.noDependencies")}</p>
                )}
              </section>
            </details>
            <section>
              <h3>{t("teams.output")}</h3>
              {record.attempts.slice(-1)[0]?.output ? (
                <TeamMessage key={latestAttempt!.threadId} runId={run.id} workspaceStore={workspaceStore} workspacePath={run.spec.workspacePath} attempt={latestAttempt!} />
              ) : (
                <p>{t(record.status === "running" ? "teams.runningOutput" : "teams.noOutput")}</p>
              )}
            </section>
            {!!record.attempts.length && (
              <section>
                <h3>{t("teams.attempts")}</h3>
                <p>{t("teams.currentAttempt")}</p>
                {record.attempts.slice(-1).map((attempt) => (
                  <div className="team-attempt" key={attempt.threadId}>
                    <button onClick={() => void openRecord(attempt.threadId)}>
                      {record.attempts.length} · {t(`teams.status.${attempt.status}`)}
                      <ArrowRight size={16} />
                      <span className="react-sr-only">{t("teams.openRecord")}</span>
                    </button>
                    {attempt.error && (
                      <p className="team-error">{attempt.error}</p>
                    )}
                  </div>
                ))}
                {record.attempts.length > 1 && <details key={latestAttempt!.threadId} className="team-attempt-history">
                  <summary>{t("teams.earlierAttempts", { count: record.attempts.length - 1 })}</summary>
                  {record.attempts.slice(0, -1).map((attempt, index) => <div className="team-attempt" key={attempt.threadId}>
                    <button onClick={() => void openRecord(attempt.threadId)}>
                      {index + 1} · {t(`teams.status.${attempt.status}`)}<ArrowRight size={16} />
                      <span className="react-sr-only">{t("teams.openRecord")}</span>
                    </button>
                    {attempt.error && <p className="team-error">{attempt.error}</p>}
                  </div>)}
                </details>}
              </section>
            )}
            {editable &&
              ["failed", "cancelled", "interrupted"].includes(record.status) && (
                <section>
                  <p>{t("teams.retryHint")}</p>
                  <button
                    disabled={disabled}
                    onClick={() => void onControl("retry", [record.task.id])}
                  >
                    {t("teams.retry")}
                  </button>
                </section>
              )}
          </aside>
        )}
      </div>
      {!editing && <TeamMemberDock run={run} selectedMemberId={record.task.memberId} onSelect={selectTask} />}
    </>
  );
}
