import { UsageHistory } from "../settings/UsageBreakdown";
import type { UsageDetailsLoader } from "../../app-core/settings/tokenUsage";
import { TeamMessage } from "./TeamMessage";
import { TeamPlanEditor } from "./TeamPlanEditor";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  Pause,
  Play,
  Square,
  UserRound,
} from "lucide-react";
import type {
  TeamPlan,
  TeamRun,
  TeamTaskRecord,
} from "../../app-core/native/desktopNativeTeams";
import { canExecute, orderedTasks, taskState } from "./teamPresentation";
import { TeamElapsedTime, TeamTaskStatus } from "./TeamTaskStatus";

type Props = {
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
  const inspectorRef = useRef<HTMLElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const backToTasksRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inspectorRef.current) inspectorRef.current.scrollTop = 0;
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
      {!editing && <section className="team-members" aria-label={t("teams.members")}>
        {run.spec.members.map((m) => {
          const active = runningTasks.find((r) => r.task.memberId === m.id);
          return (
            <button
              key={m.id}
              className={`team-member ${active ? "is-running" : ""}`}
              disabled={!active || !!draft}
              aria-label={active ? t("teams.viewMemberTask", { member: m.displayName, task: active.task.title }) : undefined}
              onClick={() => active && selectTask(active.task.id)}
            >
              <span className="team-avatar">
                <UserRound size={22} />
                {active && <span className="team-member-dot" />}
              </span>
              <span className="team-member-copy">
                <strong title={m.displayName}>{m.displayName}</strong>
                <span title={active?.task.title}>
                  {active?.task.title ?? (run.status === "running" ? t("teams.waiting") : t(`teams.status.${run.status}`))}
                </span>
              </span>
              {active && <ArrowRight size={15} className="team-member-arrow" aria-hidden="true" />}
            </button>
          );
        })}
      </section>}
      <div
        className="team-workspace"
        data-view={tab !== "tasks" ? "result" : draft ? "editor" : inspectorOpen ? "detail" : "tasks"}
      >
        <section className="team-task-pane">
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
                const tabs = ["tasks", "board", "result", "usage"];
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
          {tab === "usage" ? (
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
                  <TeamMessage runId={run.id} attempt={a} onOpenThread={id => void openRecord(id)} />
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
                <TeamMessage key={final!.attempts.slice(-1)[0]!.threadId} runId={run.id} attempt={final!.attempts.slice(-1)[0]!} onOpenThread={id => void openRecord(id)} />
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
                  {tasks.map((r, index) => (
                    <button
                      key={r.task.id}
                      ref={record.task.id === r.task.id ? selectedRowRef : undefined}
                      className={`team-task-row is-${r.status} ${record.task.id === r.task.id ? "is-selected" : ""}`}
                      aria-pressed={record.task.id === r.task.id}
                      onClick={() => selectTask(r.task.id)}
                    >
                      <span className="team-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="team-task-title">
                        <strong title={r.task.title}>{r.task.title}</strong>
                        {r.task.id === run.finalTaskId && (
                          <small>{t("teams.final")}</small>
                        )}
                        <span>
                          {r.status === "running"
                            ? run.spec.members.find((m) => m.id === r.task.memberId)!.displayName
                            : r.task.dependencies.length
                            ? r.task.dependencies
                                .map(
                                  (id) =>
                                    run.tasks.find(
                                      (task) => task.task.id === id,
                                    )!.task.title,
                                )
                                .join(" · ")
                            : t("teams.noDependencies")}
                        </span>
                      </span>
                      {r.status !== "running" && <span className="team-owner" title={run.spec.members.find((m) => m.id === r.task.memberId)!.displayName}>
                        {
                          run.spec.members.find(
                            (m) => m.id === r.task.memberId,
                          )!.displayName
                        }
                      </span>}
                      <span className="team-task-state">
                        <TeamTaskStatus run={run} record={r} />
                        {r.status === "running" && r.attempts.slice(-1)[0] && (
                          <TeamElapsedTime key={r.attempts.slice(-1)[0]!.threadId} attempt={r.attempts.slice(-1)[0]!} />
                        )}
                      </span>
                    </button>
                  ))}
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
          <aside ref={inspectorRef} className="team-inspector" aria-label={t("teams.details")}>
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
            <h2>{record.task.title}</h2>
            <p className="team-inspector-meta">
              <UserRound size={17} />
              <span className="team-inspector-owner" title={run.spec.members.find((m) => m.id === record.task.memberId)!.displayName}>
                {run.spec.members.find((m) => m.id === record.task.memberId)!.displayName}
              </span>
              <TeamTaskStatus run={run} record={record} animate={false} />
            </p>
            {record.status === "running" && (
              <div className="team-live-task">
                <div>
                  <strong>{t("teams.workingNow")}</strong>
                  {latestAttempt && <TeamElapsedTime key={latestAttempt.threadId} attempt={latestAttempt} />}
                </div>
                <p>{t("teams.runningHint")}</p>
                {latestAttempt && (
                  <button onClick={() => void openRecord(latestAttempt.threadId)}>
                    {t("teams.viewLiveRecord")}<ArrowRight size={15} />
                  </button>
                )}
              </div>
            )}
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
            <section>
              <h3>{t("teams.output")}</h3>
              {record.attempts.slice(-1)[0]?.output ? (
                <TeamMessage key={latestAttempt!.threadId} runId={run.id} attempt={latestAttempt!} onOpenThread={id => void openRecord(id)} />
              ) : (
                <p>{t(record.status === "running" ? "teams.runningOutput" : "teams.noOutput")}</p>
              )}
            </section>
            {!!record.attempts.length && (
              <section>
                <h3>{t("teams.attempts")}</h3>
                {record.attempts.map((attempt, i) => (
                  <div className="team-attempt" key={attempt.threadId}>
                    <button onClick={() => void openRecord(attempt.threadId)}>
                      {i + 1} · {t(`teams.status.${attempt.status}`)}
                      <ArrowRight size={16} />
                      <span className="react-sr-only">{t("teams.openRecord")}</span>
                    </button>
                    {attempt.error && (
                      <p className="team-error">{attempt.error}</p>
                    )}
                  </div>
                ))}
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
    </>
  );
}
