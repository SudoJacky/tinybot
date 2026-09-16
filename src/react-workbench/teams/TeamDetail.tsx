import { TeamPlanEditor } from "./TeamPlanEditor";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  Folder,
  LockKeyhole,
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
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { canExecute, orderedTasks, taskState } from "./teamPresentation";

type Props = {
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
  const [selected, setSelected] = useState(run.finalTaskId);
  const [tab, setTab] = useState("tasks");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const backToTasksRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inspectorRef.current) inspectorRef.current.scrollTop = 0;
    // Only move keyboard focus when the compact layout hides the task list.
    if (inspectorOpen && backToTasksRef.current?.getClientRects().length) {
      backToTasksRef.current.focus({ preventScroll: true });
    }
  }, [selected, inspectorOpen]);
  function selectTask(id: string) {
    setSelected(id);
    setInspectorOpen(true);
  }
  const [draft, setDraft] = useState<{
    plan: TeamPlan;
    revision: number;
  } | null>(null);
  useEffect(() => {
    onEditingChange?.(!!draft);
    return () => onEditingChange?.(false);
  }, [!!draft, onEditingChange]);
  const [error, setError] = useState<string | null>(null);
  const tasks = orderedTasks(run.tasks);
  const record = run.tasks.find((r) => r.task.id === selected) ?? run.tasks[0];
  const final = run.tasks.find((r) => r.task.id === run.finalTaskId);
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
      <header className="team-run-header">
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
      <section className="team-members" aria-label={t("teams.members")}>
        {run.spec.members.map((m) => (
          <div key={m.id}>
            <span className="team-avatar">
              <UserRound size={22} />
            </span>
            <div>
              <strong title={m.displayName}>{m.displayName}</strong>
              <p>
                {run.tasks.find(
                  (r) => r.status === "running" && r.task.memberId === m.id,
                )?.task.title ??
                  (run.status === "running"
                    ? t("teams.waiting")
                    : t(`teams.status.${run.status}`))}
              </p>
            </div>
          </div>
        ))}
      </section>
      <div
        className="team-workspace"
        data-view={tab === "result" ? "result" : draft ? "editor" : inspectorOpen ? "detail" : "tasks"}
      >
        <section className="team-task-pane">
          <div className="team-task-toolbar">
            <div
              role="tablist"
              aria-label={t("teams.details")}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "tasks"
                    : event.key === "End"
                      ? "result"
                      : tab === "tasks"
                        ? "result"
                        : "tasks";
                setTab(next);
                event.currentTarget
                  .querySelector<HTMLButtonElement>(
                    next === "tasks" ? "#team-tasks-tab" : "#team-result-tab",
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
              <button
                role="tab"
                id="team-result-tab"
                tabIndex={tab === "result" ? 0 : -1}
                aria-controls="team-result-panel"
                aria-selected={tab === "result"}
                onClick={() => setTab("result")}
              >
                {t("teams.result")}
              </button>
            </div>
            <span>
              {t("teams.completedCount", {
                done: tasks.filter((r) => r.status === "succeeded").length,
                total: tasks.length,
              })}
            </span>
          </div>
          {tab === "result" ? (
            <section
              role="tabpanel"
              id="team-result-panel"
              aria-labelledby="team-result-tab"
              className="team-result"
            >
              {result ? (
                <AssistantMarkdown
                  text={result}
                  streaming={false}
                  onOpenFileLink={() => {
                    if (final?.attempts.slice(-1)[0])
                      void openRecord(final.attempts.slice(-1)[0]!.threadId);
                  }}
                />
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
                        setDraft(null);
                        setError(null);
                      }
                    });
                  }}
                  onDiscard={() => {
                    setDraft(null);
                    setError(null);
                  }}
                />
              ) : (
                <>
                  {tasks.map((r, index) => (
                    <button
                      key={r.task.id}
                      ref={record.task.id === r.task.id ? selectedRowRef : undefined}
                      className={`team-task-row ${record.task.id === r.task.id ? "is-selected" : ""}`}
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
                          {r.task.dependencies.length
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
                      <span className="team-owner" title={run.spec.members.find((m) => m.id === r.task.memberId)!.displayName}>
                        {
                          run.spec.members.find(
                            (m) => m.id === r.task.memberId,
                          )!.displayName
                        }
                      </span>
                      <span className={`team-status is-${r.status}`}>
                        {r.status === "succeeded" ? (
                          <Check size={18} />
                        ) : taskState(run, r) === "blocked" ? (
                          <LockKeyhole size={17} />
                        ) : (
                          <Circle size={16} />
                        )}
                        {status(r)}
                      </span>
                    </button>
                  ))}
                  {editable && (
                    <button
                      className="team-edit-button"
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
              <span>{status(record)}</span>
            </p>
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
                <AssistantMarkdown
                  text={record.attempts.slice(-1)[0]!.output!}
                  streaming={false}
                  onOpenFileLink={() =>
                    void openRecord(record.attempts.slice(-1)[0]!.threadId)
                  }
                />
              ) : (
                <p>{t("teams.noOutput")}</p>
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
                      <span className="sr-only">{t("teams.openRecord")}</span>
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
