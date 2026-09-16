use super::{model::*, store, TeamRunInput};
use async_trait::async_trait;
use futures_util::{stream::FuturesUnordered, FutureExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Control {
    pub pause: AtomicBool,
    pub cancel: CancellationToken,
}

#[derive(Clone)]
pub(crate) struct TaskJob {
    pub run_id: String,
    pub task: TeamTask,
    pub member: TeamMember,
    pub workspace_path: String,
    pub thread_id: String,
    pub turn_id: String,
    pub input: Value,
}

pub(crate) enum TaskOutcome {
    Succeeded(String),
    Failed(String),
    Cancelled,
}

#[async_trait]
pub(crate) trait TaskExecutor: Send + Sync {
    async fn execute(&self, job: TaskJob, cancellation: CancellationToken) -> TaskOutcome;
}

struct Registration {
    path: PathBuf,
    control: Arc<Control>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.control.cancel.cancel();
        match store::lock() {
            Ok(mut active) => {
                active.remove(&self.path);
            }
            Err(error) => eprintln!("team_registry_cleanup_failed error={error}"),
        }
    }
}

// The owned scheduler survives a dropped command response. All exits drain attempts.
pub(crate) async fn execute(
    root: &Path,
    input: TeamRunInput,
    executor: Arc<dyn TaskExecutor>,
) -> Result<TeamRun, String> {
    let path = store::path(&store::directory(root)?, &input.run_id)?;
    let control = Arc::new(Control::default());
    let mut run = {
        let mut active = store::lock()?;
        let mut run = store::read(&path, &active)?;
        store::expect_revision(&run, input.expected_revision)?;
        if active.contains_key(&path) || active.len() >= 4 {
            return Err("Team run is already active or the four-run limit has been reached".into());
        }
        if !matches!(
            run.status,
            RunStatus::Planned | RunStatus::Paused | RunStatus::Interrupted
        ) {
            return Err("Team execution requires a planned, paused, or reconciled run".into());
        }
        if run
            .tasks
            .iter()
            .any(|r| !matches!(r.status, TaskStatus::Pending | TaskStatus::Succeeded))
        {
            return Err(
                "Explicitly retry failed, cancelled, or interrupted tasks before starting".into(),
            );
        }
        run.status = RunStatus::Running;
        run.error = None;
        store::save(&path, &mut run)?;
        active.insert(path.clone(), control.clone());
        run
    };
    let registration = Registration { path, control };
    tokio::spawn(async move {
        let result = schedule(&registration, &mut run, executor).await;
        drop(registration);
        result.map(|()| run)
    })
    .await
    .map_err(|error| format!("Team scheduler stopped unexpectedly: {error}"))?
}

fn persist(registration: &Registration, run: &mut TeamRun) -> Result<(), String> {
    let _lock = store::lock()?;
    store::save(&registration.path, run)
}

async fn schedule(
    registration: &Registration,
    run: &mut TeamRun,
    executor: Arc<dyn TaskExecutor>,
) -> Result<(), String> {
    let control = &registration.control;
    let mut inflight = FuturesUnordered::new();
    let mut storage_error = None;
    loop {
        if storage_error.is_none()
            && run.error.is_none()
            && !control.cancel.is_cancelled()
            && !control.pause.load(Ordering::SeqCst)
        {
            let succeeded: HashSet<_> = run
                .tasks
                .iter()
                .filter(|r| r.status == TaskStatus::Succeeded)
                .map(|r| r.task.id.clone())
                .collect();
            let mut busy: HashSet<_> = run
                .tasks
                .iter()
                .filter(|r| r.status == TaskStatus::Running)
                .map(|r| r.task.member_id.clone())
                .collect();
            for index in 0..run.tasks.len() {
                if inflight.len() >= run.spec.max_concurrency
                    || control.cancel.is_cancelled()
                    || control.pause.load(Ordering::SeqCst)
                {
                    break;
                }
                let record = &run.tasks[index];
                if record.status != TaskStatus::Pending
                    || busy.contains(&record.task.member_id)
                    || !record
                        .task
                        .dependencies
                        .iter()
                        .all(|id| succeeded.contains(id))
                {
                    continue;
                }
                let job = begin_attempt(run, index);
                if let Err(error) = persist(registration, run) {
                    storage_error = Some(error);
                    control.cancel.cancel();
                    break;
                }
                eprintln!(
                    "team_task_started run_id={} task_id={} member_id={} thread_id={}",
                    run.id, job.task.id, job.member.id, job.thread_id
                );
                busy.insert(job.member.id.clone());
                let executor = executor.clone();
                let cancellation = control.cancel.clone();
                inflight.push(async move {
                    let outcome = std::panic::AssertUnwindSafe(executor.execute(job, cancellation))
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            TaskOutcome::Failed(
                                "Team task executor panicked; inspect its Thread before retrying"
                                    .into(),
                            )
                        });
                    (index, outcome)
                });
            }
        }
        let Some((index, outcome)) = inflight.next().await else {
            break;
        };
        let record = &mut run.tasks[index];
        let attempt = record
            .attempts
            .last_mut()
            .expect("dispatched Team task has an attempt");
        match outcome {
            TaskOutcome::Succeeded(output) if !output.trim().is_empty() => {
                record.status = TaskStatus::Succeeded;
                attempt.output = Some(output);
            }
            TaskOutcome::Succeeded(_) | TaskOutcome::Failed(_) => {
                let error = match outcome {
                    TaskOutcome::Failed(error) => error,
                    _ => "Team task returned an empty result".into(),
                };
                record.status = TaskStatus::Failed;
                attempt.error = Some(error.clone());
                if run.error.is_none() {
                    run.error = Some(format!("Task {} failed: {error}", record.task.id));
                }
                control.cancel.cancel();
            }
            TaskOutcome::Cancelled => {
                record.status = TaskStatus::Cancelled;
                control.cancel.cancel();
            }
        }
        attempt.status = record.status;
        attempt.finished_at = Some(store::now());
        eprintln!(
            "team_task_finished run_id={} task_id={} status={:?} error={:?}",
            run.id, record.task.id, record.status, attempt.error
        );
        if storage_error.is_none() {
            if let Err(error) = persist(registration, run) {
                storage_error = Some(error);
                control.cancel.cancel();
            }
        }
    }
    if let Some(error) = storage_error {
        eprintln!("team_persistence_failed run_id={} error={error}", run.id);
        return Err(error);
    }
    run.status = if run.error.is_some() {
        RunStatus::Failed
    } else if control.cancel.is_cancelled() {
        RunStatus::Cancelled
    } else if run.tasks.iter().all(|r| r.status == TaskStatus::Succeeded) {
        RunStatus::Completed
    } else if control.pause.load(Ordering::SeqCst) {
        RunStatus::Paused
    } else {
        run.error = Some("Team scheduler has unfinished tasks but no runnable work".into());
        RunStatus::Failed
    };
    persist(registration, run)
}

fn begin_attempt(run: &mut TeamRun, index: usize) -> TaskJob {
    let record = &run.tasks[index];
    let dependencies: Vec<_> = record.task.dependencies.iter().map(|id| {
        let dependency = run.tasks.iter().find(|r| &r.task.id == id).expect("validated dependency");
        json!({"taskId": id, "memberId": dependency.task.member_id, "output": dependency.attempts.last().expect("successful attempt").output})
    }).collect();
    let thread_id = format!(
        "{}-{}-{}",
        run.id,
        record.task.id,
        record.attempts.len() + 1
    );
    let turn_id = format!("{thread_id}-turn");
    let job = TaskJob {
        run_id: run.id.clone(),
        task: record.task.clone(),
        member: run
            .spec
            .members
            .iter()
            .find(|m| m.id == record.task.member_id)
            .expect("validated member")
            .clone(),
        workspace_path: run.spec.workspace_path.clone(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        input: json!({"goal": run.spec.goal, "task": record.task, "dependencyResults": dependencies}),
    };
    let record = &mut run.tasks[index];
    record.status = TaskStatus::Running;
    record.attempts.push(TeamAttempt {
        thread_id,
        turn_id,
        status: TaskStatus::Running,
        started_at: store::now(),
        finished_at: None,
        output: None,
        error: None,
    });
    job
}
