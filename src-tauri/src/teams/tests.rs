use super::model::{RunStatus, TaskStatus, TeamMember, TeamTask};
use super::runtime::{TaskExecutor, TaskJob, TaskOutcome};
use super::*;
use async_trait::async_trait;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

static EXECUTION_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tinybot-test-{}", store::next_id()));
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }
    fn spec(&self) -> TeamSpec {
        TeamSpec {
            goal: "Compare evidence and write a report".into(),
            workspace_path: self.root.to_string_lossy().into_owned(),
            max_concurrency: 2,
            members: ["research", "review"]
                .into_iter()
                .map(|id| TeamMember {
                    id: id.into(),
                    instructions: format!("Act as {id}"),
                    model: None,
                })
                .collect(),
        }
    }
    fn prepare(&self) -> TeamRun {
        prepare(&self.root, self.spec(), fork_plan()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn task(id: &str, member: &str, dependencies: &[&str]) -> TeamTask {
    TeamTask {
        id: id.into(),
        member_id: member.into(),
        instructions: format!("Produce evidence for {id}"),
        dependencies: dependencies.iter().map(|id| (*id).into()).collect(),
    }
}
fn fork_plan() -> TeamPlan {
    TeamPlan {
        tasks: vec![
            task("a", "research", &[]),
            task("b", "review", &[]),
            task("final", "review", &["a", "b"]),
        ],
        final_task_id: "final".into(),
    }
}
fn start_input(run: &TeamRun) -> TeamRunInput {
    TeamRunInput {
        run_id: run.id.clone(),
        expected_revision: run.revision,
    }
}
fn control_input(run: &TeamRun, action: TeamAction, ids: &[&str]) -> ControlTeamInput {
    ControlTeamInput {
        run_id: run.id.clone(),
        expected_revision: run.revision,
        action,
        task_ids: ids.iter().map(|s| (*s).into()).collect(),
    }
}

struct ControlledExecutor {
    started: mpsc::UnboundedSender<(TaskJob, oneshot::Sender<TaskOutcome>)>,
}
#[async_trait]
impl TaskExecutor for ControlledExecutor {
    async fn execute(&self, job: TaskJob, cancellation: CancellationToken) -> TaskOutcome {
        let (send, receive) = oneshot::channel();
        self.started.send((job, send)).unwrap();
        tokio::select! {
            result = receive => result.unwrap(),
            _ = cancellation.cancelled() => TaskOutcome::Cancelled,
        }
    }
}
fn controlled() -> (
    Arc<ControlledExecutor>,
    mpsc::UnboundedReceiver<(TaskJob, oneshot::Sender<TaskOutcome>)>,
) {
    let (started, receiver) = mpsc::unbounded_channel();
    (Arc::new(ControlledExecutor { started }), receiver)
}
async fn next(
    receiver: &mut mpsc::UnboundedReceiver<(TaskJob, oneshot::Sender<TaskOutcome>)>,
) -> (TaskJob, oneshot::Sender<TaskOutcome>) {
    tokio::time::timeout(Duration::from_secs(15), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}
fn success(send: oneshot::Sender<TaskOutcome>, text: &str) {
    assert!(send.send(TaskOutcome::Succeeded(text.into())).is_ok());
}
fn launch(
    f: &Fixture,
    run: &TeamRun,
    executor: Arc<dyn TaskExecutor>,
) -> tokio::task::JoinHandle<Result<TeamRun, String>> {
    let root = f.root.clone();
    let input = start_input(run);
    tokio::spawn(async move { execute(&root, input, executor).await })
}

#[test]
fn rejects_invalid_and_incomplete_dependency_plans() {
    let f = Fixture::new();
    let mut plan = fork_plan();
    plan.tasks[0].dependencies.push("final".into());
    assert!(prepare(&f.root, f.spec(), plan)
        .unwrap_err()
        .contains("cycle"));
    let mut plan = fork_plan();
    plan.tasks[2].dependencies.pop();
    assert!(prepare(&f.root, f.spec(), plan)
        .unwrap_err()
        .contains("contribute"));
    let mut plan = fork_plan();
    plan.tasks[0].member_id = "invented".into();
    assert!(prepare(&f.root, f.spec(), plan).is_err());
    let mut plan = fork_plan();
    plan.tasks[1].id = "a".into();
    assert!(prepare(&f.root, f.spec(), plan)
        .unwrap_err()
        .contains("Duplicate"));
    assert!(get(&f.root, "../escape").is_err());
    assert!(planner::parse_plan(&f.spec(), "```json\n{}\n```").is_err());
    let raw = serde_json::to_string(&fork_plan()).unwrap();
    assert_eq!(planner::parse_plan(&f.spec(), &raw).unwrap(), fork_plan());
}

#[tokio::test]
async fn parallel_fanout_waits_for_all_inputs_and_persists_results() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = f.prepare();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor.clone());
    let mut pending = HashMap::new();
    for _ in 0..2 {
        let (job, done) = next(&mut rx).await;
        pending.insert(job.task.id, done);
    }
    let running = get(&f.root, &run.id).unwrap();
    assert_eq!(
        running
            .tasks
            .iter()
            .filter(|r| r.status == TaskStatus::Running)
            .count(),
        2
    );
    assert!(execute(&f.root, start_input(&running), executor)
        .await
        .unwrap_err()
        .contains("already active"));
    success(pending.remove("a").unwrap(), "evidence A");
    assert!(tokio::time::timeout(Duration::from_millis(40), rx.recv())
        .await
        .is_err());
    success(pending.remove("b").unwrap(), "evidence B");
    let (job, done) = next(&mut rx).await;
    assert_eq!(job.task.id, "final");
    assert_eq!(job.input["dependencyResults"][0]["output"], "evidence A");
    assert_eq!(job.input["dependencyResults"][1]["output"], "evidence B");
    success(done, "checked report");
    let result = handle.await.unwrap().unwrap();
    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(
        get(&f.root, &run.id).unwrap().tasks[2].attempts[0]
            .output
            .as_deref(),
        Some("checked report")
    );
    assert_eq!(list(&f.root).unwrap().len(), 1);
}

#[tokio::test]
async fn concurrency_and_member_limits_are_hard_bounds() {
    let _serial = EXECUTION_TESTS.lock().await;
    for same_member in [false, true] {
        let f = Fixture::new();
        let mut spec = f.spec();
        let mut plan = fork_plan();
        if same_member {
            plan.tasks[1].member_id = "research".into();
        } else {
            spec.max_concurrency = 1;
        }
        let run = prepare(&f.root, spec, plan).unwrap();
        let (executor, mut rx) = controlled();
        let handle = launch(&f, &run, executor);
        for id in ["a", "b", "final"] {
            let (job, done) = next(&mut rx).await;
            assert_eq!(job.task.id, id);
            assert!(rx.try_recv().is_err());
            success(done, id);
        }
        assert_eq!(handle.await.unwrap().unwrap().status, RunStatus::Completed);
    }
}

#[tokio::test]
async fn failure_drains_siblings_and_requires_explicit_retry() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = f.prepare();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor.clone());
    let (a, fail) = next(&mut rx).await;
    let (b, _pending) = next(&mut rx).await;
    assert!(fail
        .send(TaskOutcome::Failed("provider failed".into()))
        .is_ok());
    let failed = handle.await.unwrap().unwrap();
    assert_eq!(failed.status, RunStatus::Failed);
    assert_eq!(failed.tasks[2].status, TaskStatus::Pending);
    assert!(execute(&f.root, start_input(&failed), executor.clone())
        .await
        .is_err());
    assert!(control(
        &f.root,
        control_input(&failed, TeamAction::Retry, &["missing"])
    )
    .is_err());
    let retry = control(
        &f.root,
        control_input(&failed, TeamAction::Retry, &[&a.task.id, &b.task.id]),
    )
    .unwrap();
    let handle = launch(&f, &retry, executor);
    for _ in 0..3 {
        let (job, done) = next(&mut rx).await;
        assert_ne!(job.thread_id, a.thread_id);
        assert_ne!(job.thread_id, b.thread_id);
        success(done, "recovered");
    }
    let completed = handle.await.unwrap().unwrap();
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.tasks[0].attempts.len(), 2);
    assert_eq!(completed.tasks[1].attempts.len(), 2);
}

#[tokio::test]
async fn pause_drains_and_resume_preserves_successful_attempts() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = f.prepare();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor.clone());
    let (_, a) = next(&mut rx).await;
    let (_, b) = next(&mut rx).await;
    let running = get(&f.root, &run.id).unwrap();
    control(&f.root, control_input(&running, TeamAction::Pause, &[])).unwrap();
    success(a, "A");
    success(b, "B");
    let paused = handle.await.unwrap().unwrap();
    assert_eq!(paused.status, RunStatus::Paused);
    assert_eq!(paused.tasks[2].status, TaskStatus::Pending);
    let mut plan = paused.plan();
    plan.tasks[0].instructions = "rewrite completed work".into();
    assert!(revise(
        &f.root,
        ReviseTeamInput {
            run_id: run.id.clone(),
            expected_revision: paused.revision,
            plan
        }
    )
    .is_err());
    let mut plan = paused.plan();
    plan.tasks[2].instructions = "Write a brief report".into();
    let revised = revise(
        &f.root,
        ReviseTeamInput {
            run_id: run.id.clone(),
            expected_revision: paused.revision,
            plan,
        },
    )
    .unwrap();
    assert!(
        control(&f.root, control_input(&paused, TeamAction::Cancel, &[]))
            .unwrap_err()
            .contains("Stale")
    );
    let handle = launch(&f, &revised, executor);
    let (job, done) = next(&mut rx).await;
    assert_eq!(job.task.id, "final");
    success(done, "report");
    let completed = handle.await.unwrap().unwrap();
    assert_eq!(completed.status, RunStatus::Completed);
    assert!(completed.tasks.iter().all(|r| r.attempts.len() == 1));
}

#[tokio::test]
async fn cancel_drains_active_work_and_dropped_callers_do_not_orphan_runs() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = f.prepare();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor);
    let (_, _a) = next(&mut rx).await;
    let (_, _b) = next(&mut rx).await;
    handle.abort();
    let running = get(&f.root, &run.id).unwrap();
    assert_eq!(running.status, RunStatus::Running);
    control(&f.root, control_input(&running, TeamAction::Cancel, &[])).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let result = get(&f.root, &run.id).unwrap();
            if result.status == RunStatus::Cancelled {
                assert_eq!(result.tasks[0].status, TaskStatus::Cancelled);
                assert_eq!(result.tasks[1].status, TaskStatus::Cancelled);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn crash_reconciliation_never_automatically_replays_attempts() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let mut run = f.prepare();
    run.status = RunStatus::Running;
    run.tasks[0].status = TaskStatus::Running;
    run.tasks[0].attempts.push(model::TeamAttempt {
        thread_id: "uncertain-thread".into(),
        turn_id: "uncertain-turn".into(),
        status: TaskStatus::Running,
        started_at: store::now(),
        finished_at: None,
        output: None,
        error: None,
    });
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    {
        let _lock = store::lock().unwrap();
        store::save(&path, &mut run).unwrap();
    }
    let recovered = get(&f.root, &run.id).unwrap();
    assert_eq!(recovered.status, RunStatus::Interrupted);
    assert_eq!(recovered.tasks[0].status, TaskStatus::Interrupted);
    assert_eq!(recovered.revision, run.revision + 1);
    assert_eq!(get(&f.root, &run.id).unwrap().revision, recovered.revision);
    let (executor, _rx) = controlled();
    assert!(execute(&f.root, start_input(&recovered), executor)
        .await
        .unwrap_err()
        .contains("Explicitly retry"));
    std::fs::write(&path, b"broken JSON").unwrap();
    assert!(get(&f.root, &run.id)
        .unwrap_err()
        .contains("Parse Team run"));
}

#[tokio::test]
async fn native_executor_creates_real_threads_and_persists_origin() {
    let _serial = EXECUTION_TESTS.lock().await;
    use crate::agent::bridge::TestApplicationServices;
    use crate::agent::runtime::NativeAgentRuntimeServices;
    let f = Fixture::new();
    let run = f.prepare();
    let services = NativeAgentRuntimeServices::with_subagent_manager(Default::default())
        .with_thread_store(
            crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
                f.root.clone(),
                f.root.join("native"),
                crate::protocol::capability::default_desktop_capability_policy(),
            ),
        );
    let thread_store = services.thread_store.clone();
    let result = execute(
        &f.root,
        start_input(&run),
        Arc::new(NativeTeamExecutor {
            services,
            workspace_root: f.root.clone(),
            config: json!({
                "agents": {"defaults": {"provider": "fixture", "model": "fixture-model"}},
                "providers": {"fixture": {"responses": [{"content": "Team fixture result"}]}}
            }),
        }),
    )
    .await
    .unwrap();
    assert_eq!(result.status, RunStatus::Completed, "{:?}", result.error);
    let listed = crate::rpc::call_rust_state_service(
        &thread_store,
        json!({}),
        crate::protocol::WorkerRequest::new(
            "team-test-list",
            "team-test-list",
            "thread.list",
            json!({"includeChildThreads": true}),
        ),
        "Team test list",
    )
    .unwrap();
    for record in &result.tasks {
        let thread = listed["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|thread| thread["threadId"] == record.attempts[0].thread_id)
            .unwrap();
        assert_eq!(thread["source"], "team");
        assert_eq!(
            thread["metadata"]["workingDirectory"],
            result.spec.workspace_path
        );
        assert_eq!(thread["metadata"]["extra"]["teamRunId"], run.id);
        assert_eq!(thread["metadata"]["extra"]["teamTaskId"], record.task.id);
        assert_eq!(
            record.attempts[0].output.as_deref(),
            Some("Team fixture result")
        );
    }
}

#[tokio::test]
async fn persistence_failure_cancels_work_and_keeps_the_last_durable_board() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = f.prepare();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor);
    let (_, completed) = next(&mut rx).await;
    let (_, _sibling) = next(&mut rx).await;
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    let backup = path.with_extension("backup");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    success(completed, "result that cannot be committed");
    let error = handle.await.unwrap().unwrap_err();
    assert!(error.contains("Persist Team run"), "{error}");
    assert!(rx.try_recv().is_err(), "downstream work must not start");
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    let recovered = get(&f.root, &run.id).unwrap();
    assert_eq!(recovered.status, RunStatus::Interrupted);
    assert!(recovered.tasks[..2]
        .iter()
        .all(|r| r.status == TaskStatus::Interrupted));
    assert!(recovered
        .tasks
        .iter()
        .all(|r| r.attempts.iter().all(|a| a.output.is_none())));
}

#[tokio::test]
async fn retry_after_partial_success_does_not_repeat_completed_work() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let mut spec = f.spec();
    spec.max_concurrency = 1;
    let run = prepare(&f.root, spec, fork_plan()).unwrap();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor.clone());
    let (first, done) = next(&mut rx).await;
    success(done, "durable evidence");
    let (_, failed) = next(&mut rx).await;
    assert!(failed
        .send(TaskOutcome::Failed("unavailable".into()))
        .is_ok());
    let failed = handle.await.unwrap().unwrap();
    let retry = control(&f.root, control_input(&failed, TeamAction::Retry, &["b"])).unwrap();
    let handle = launch(&f, &retry, executor);
    let (job, done) = next(&mut rx).await;
    assert_eq!(job.task.id, "b");
    success(done, "new evidence");
    let (job, done) = next(&mut rx).await;
    assert_eq!(
        job.input["dependencyResults"][0]["output"],
        "durable evidence"
    );
    success(done, "report");
    let completed = handle.await.unwrap().unwrap();
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.tasks[0].attempts.len(), 1);
    assert_eq!(completed.tasks[0].attempts[0].thread_id, first.thread_id);
    assert_eq!(completed.tasks[1].attempts.len(), 2);
}
