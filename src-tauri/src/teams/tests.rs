use super::model::{RunStatus, TaskStatus, TeamMember, TeamTask};
use super::runtime::{TaskExecutor, TaskJob, TaskOutcome};
use super::*;
use async_trait::async_trait;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

static EXECUTION_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct BoardProvider {
    calls: std::sync::Mutex<HashMap<String, usize>>,
    members: Vec<TeamMember>,
}
impl crate::agent::runtime::test_support::BlockingTestProvider for BoardProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        use crate::agent::runtime::{NativeAgentProviderResponse, NativeAgentToolCall};
        let task = context.metadata["teamTaskId"].as_str().unwrap();
        let mut calls = self.calls.lock().unwrap();
        let step = calls.entry(task.into()).or_default();
        let legacy_messages = context.messages.to_legacy_messages().unwrap();
        if *step == 0 {
            let member = self
                .members
                .iter()
                .find(|member| context.metadata["teamMemberId"] == member.id)
                .unwrap();
            let role = context
                .system_instruction_prompt()
                .expect("the member role must reach the model as an instruction");
            let identity: serde_json::Value = serde_json::from_str(
                role.lines()
                    .find_map(|line| line.strip_prefix("Your identity: "))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(identity["memberId"], member.id);
            assert_eq!(identity["displayName"], member.display_name);
            assert!(role.contains(&member.instructions));
            for teammate in self.members.iter().filter(|other| other.id != member.id) {
                assert!(
                    !role.contains(&teammate.instructions),
                    "teammate responsibilities must not become the acting member's instructions"
                );
            }
            let input = legacy_messages
                .iter()
                .filter(|message| message["role"] == "user")
                .filter_map(|message| message["content"].as_str())
                .filter_map(|content| serde_json::from_str::<serde_json::Value>(content).ok())
                .find(|input| input.get("teamMembers").is_some())
                .expect("each task must receive the configured team roster");
            assert_eq!(input["task"]["memberId"], member.id);
            let roster = input["teamMembers"].as_array().unwrap();
            assert_eq!(roster.len(), self.members.len());
            for expected in &self.members {
                let entry = roster
                    .iter()
                    .find(|entry| entry["memberId"] == expected.id)
                    .unwrap();
                assert_eq!(entry["displayName"], expected.display_name);
                assert_eq!(entry["responsibilities"], expected.instructions);
                assert_eq!(entry.as_object().unwrap().len(), 3);
            }
        }
        let messages = serde_json::to_string(&legacy_messages).unwrap();
        let id = format!("{}-a-1", context.metadata["teamRunId"].as_str().unwrap());
        let (name, arguments) = match (task, *step) {
            ("a", 0) => (
                "apply_patch",
                json!({"patch": format!("*** Begin Patch\n*** Add File: evidence.txt\n{}*** End Patch\n", "+LARGE_EVIDENCE_MARKER\n".repeat(10_000))}),
            ),
            ("a", 1) => (
                super::tools::COMPLETE,
                json!({"summary":"x".repeat(1025),"artifacts":["evidence.txt"],"unresolved":""}),
            ),
            ("a", 2) => {
                assert!(
                    messages.contains("1024"),
                    "validation errors must return to the model"
                );
                ("team.list_messages", json!({"limit":1}))
            }
            ("b", 0) => ("team.list_messages", json!({"limit":1})),
            ("final", 0) => {
                assert!(!messages.contains("LARGE_EVIDENCE_MARKER"));
                assert!(
                    messages.len() < 40_000,
                    "dependency input must remain bounded"
                );
                ("team.read_message", json!({"entryId":id}))
            }
            ("final", 1) => {
                assert!(messages.contains("evidence.txt"));
                assert!(!messages.contains("LARGE_EVIDENCE_MARKER"));
                (
                    "team.read_artifact",
                    json!({"entryId":id,"artifactIndex":0,"maxBytes":128}),
                )
            }
            ("final", 2) => {
                assert!(messages.contains("LARGE_EVIDENCE_MARKER"));
                assert!(messages.contains("nextByteOffset"));
                (
                    super::tools::COMPLETE,
                    json!({"summary":"Team fixture result","artifacts":[],"unresolved":""}),
                )
            }
            ("a", 3) | ("b", 1) => (
                super::tools::COMPLETE,
                json!({"summary":"Team fixture result","artifacts": if task == "a" { vec!["evidence.txt"] } else { vec![] },"unresolved":""}),
            ),
            _ => panic!("completion must not cause another model call: {task}/{step}"),
        };
        *step += 1;
        Ok(NativeAgentProviderResponse {
            final_content: String::new(),
            reasoning_delta: None,
            usage: None,
            tool_calls: vec![NativeAgentToolCall {
                id: format!("board-{task}-{step}"),
                name: name.into(),
                arguments_json: arguments.to_string(),
                result: json!({}),
            }],
            response_items: vec![],
        })
    }
}

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
                    display_name: id.into(),
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
        title: id.into(),
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
    assert!(send
        .send(TaskOutcome::Succeeded(
            json!({"summary":text,"artifacts":[],"unresolved":"","sequence":0}).to_string()
        ))
        .is_ok());
}

#[test]
fn board_artifacts_are_bounded_verified_and_workspace_scoped() {
    use crate::protocol::capability::{default_desktop_capability_policy, CapabilityPolicy};
    let f = Fixture::new();
    let mut run = f.prepare();
    let source = "你好，evidence\n".repeat(10_000);
    std::fs::write(f.root.join("evidence.txt"), &source).unwrap();
    let input = json!({"summary":"Evidence collected","artifacts":["evidence.txt"],"unresolved":"Check API limits"});
    let mut message =
        board::complete(&f.root, default_desktop_capability_policy(), input.clone()).unwrap();
    message.sequence = 3;
    run.tasks[0].status = TaskStatus::Succeeded;
    run.tasks[0].attempts.push(model::TeamAttempt {
        thread_id: "entry-a".into(),
        turn_id: "turn-a".into(),
        status: TaskStatus::Succeeded,
        started_at: store::now(),
        finished_at: Some(store::now()),
        output: Some(message.summary.clone()),
        message: Some(message),
        error: None,
    });
    let page = board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        0,
        128,
    )
    .unwrap();
    assert!(page["text"].as_str().unwrap().len() <= 128);
    assert_eq!(page["totalBytes"], source.len());
    let next = page["nextByteOffset"].as_u64().unwrap() as usize;
    let second = board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        next,
        128,
    )
    .unwrap();
    assert_eq!(second["byteOffset"], next);
    assert!(board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        1,
        128
    )
    .is_err());
    assert!(board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        0,
        8193
    )
    .is_err());
    assert!(board::read_artifact(&run, CapabilityPolicy::new([]), "entry-a", 0, 0, 128).is_err());
    assert!(board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "other-run-entry",
        0,
        0,
        128
    )
    .is_err());
    assert!(board::list(&run, 3, 0, 8, None).unwrap()["entries"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        board::list(&run, 0, 0, 1, None).unwrap()["entries"][0]["entryId"],
        "entry-a"
    );
    std::fs::write(
        f.root.join("evidence.txt"),
        source.replace("evidence", "replaced"),
    )
    .unwrap();
    assert!(board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        0,
        128
    )
    .unwrap_err()
    .contains("changed"));
    std::fs::remove_file(f.root.join("evidence.txt")).unwrap();
    assert!(board::read_artifact(
        &run,
        default_desktop_capability_policy(),
        "entry-a",
        0,
        0,
        128
    )
    .is_err());
    for args in [
        json!({"summary":"x","artifacts":["../escape"],"unresolved":""}),
        json!({"summary":"x".repeat(1025),"artifacts":[],"unresolved":""}),
        json!({"summary":"x","artifacts":[],"unresolved":"","author":"forged"}),
    ] {
        assert!(board::complete(&f.root, default_desktop_capability_policy(), args).is_err());
    }
}

#[test]
fn board_bounds_total_dependency_summaries_and_migrates_legacy_output_by_reference() {
    let f = Fixture::new();
    let ids: Vec<String> = (0..63).map(|i| format!("task-{i}")).collect();
    let mut tasks: Vec<_> = ids.iter().map(|id| task(id, "research", &[])).collect();
    tasks.push(task(
        "final",
        "review",
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
    ));
    let mut run = prepare(
        &f.root,
        f.spec(),
        TeamPlan {
            tasks,
            final_task_id: "final".into(),
        },
    )
    .unwrap();
    for (i, record) in run.tasks.iter_mut().take(63).enumerate() {
        record.status = TaskStatus::Succeeded;
        record.attempts.push(model::TeamAttempt {
            thread_id: format!("entry-{i}"),
            turn_id: format!("turn-{i}"),
            status: TaskStatus::Succeeded,
            started_at: store::now(),
            finished_at: Some(store::now()),
            output: Some("x".repeat(100_000)),
            error: None,
            message: Some(board::BoardMessage {
                summary: "x".repeat(1024),
                artifacts: vec![],
                unresolved: String::new(),
                sequence: i as u64 + 1,
            }),
        });
    }
    let deps = board::dependencies(&run, &run.tasks[63].task);
    assert_eq!(deps.len(), 63);
    assert_eq!(
        deps.iter()
            .filter_map(|d| d["summary"].as_str())
            .map(str::len)
            .sum::<usize>(),
        8192
    );
    assert!(serde_json::to_vec(&deps).unwrap().len() < 40_000);
    assert!(deps.iter().all(|d| d.get("output").is_none()));
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    let mut legacy = serde_json::to_value(&run).unwrap();
    legacy["schemaVersion"] = json!(2);
    for record in legacy["tasks"].as_array_mut().unwrap() {
        for attempt in record["attempts"].as_array_mut().unwrap() {
            attempt.as_object_mut().unwrap().remove("message");
        }
    }
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let migrated = get(&f.root, &run.id).unwrap();
    assert_eq!(migrated.schema_version, 3);
    assert_eq!(
        migrated.tasks[0].attempts[0].output.as_ref().unwrap().len(),
        100_000
    );
    let deps = board::dependencies(&migrated, &migrated.tasks[63].task);
    assert!(deps
        .iter()
        .all(|d| d.get("summary").is_none() && d["legacy"] == true));
    let page = board::read(&migrated, "entry-0", 0, 128).unwrap();
    assert_eq!(page["legacyOutput"]["nextByteOffset"], 128);
    assert_eq!(page["legacyOutput"]["text"].as_str().unwrap().len(), 128);
}

#[tokio::test]
async fn malformed_completion_does_not_publish_or_release_dependencies() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let mut spec = f.spec();
    spec.max_concurrency = 1;
    let run = prepare(&f.root, spec, fork_plan()).unwrap();
    let (executor, mut rx) = controlled();
    let handle = launch(&f, &run, executor);
    let (_, done) = next(&mut rx).await;
    assert!(done
        .send(TaskOutcome::Succeeded(
            "plain prose is not a handoff".into()
        ))
        .is_ok());
    let result = handle.await.unwrap().unwrap();
    assert_eq!(result.status, RunStatus::Failed);
    assert!(result.tasks[0].attempts[0].message.is_none());
    assert!(result.tasks[2].attempts.is_empty());
    assert!(rx.try_recv().is_err());
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
    assert_eq!(job.input["dependencyResults"][0]["summary"], "evidence A");
    assert_eq!(job.input["dependencyResults"][1]["summary"], "evidence B");
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
        message: None,
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
    let mut spec = f.spec();
    // Custom responsibilities and duplicate display names must survive the
    // scheduler, persisted run, and instruction assembly without name matching.
    spec.members[0].display_name = "证据专家".into();
    spec.members[0].instructions = "Collect source documents and flag evidence gaps.".into();
    spec.members[1].display_name = "证据专家".into();
    spec.members[1].instructions = "Audit the evidence and explain conflicting conclusions.".into();
    spec.members.push(TeamMember {
        id: "archivist".into(),
        display_name: "Archivist".into(),
        instructions: "Index published artifacts for later retrieval.".into(),
        model: None,
    });
    let run = prepare(&f.root, spec, fork_plan()).unwrap();
    let provider = Arc::new(BoardProvider {
        calls: Default::default(),
        members: run.spec.members.clone(),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(
        crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
            f.root.clone(),
            f.root.clone(),
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
    assert_eq!(
        *provider.calls.lock().unwrap(),
        HashMap::from([("a".into(), 4), ("b".into(), 2), ("final".into(), 3)])
    );
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
        job.input["dependencyResults"][0]["summary"],
        "durable evidence"
    );
    success(done, "report");
    let completed = handle.await.unwrap().unwrap();
    assert_eq!(completed.status, RunStatus::Completed);
    assert_eq!(completed.tasks[0].attempts.len(), 1);
    assert_eq!(completed.tasks[0].attempts[0].thread_id, first.thread_id);
    assert_eq!(completed.tasks[1].attempts.len(), 2);
}
#[test]
fn requires_display_fields_and_migrates_legacy_records_once() {
    let f = Fixture::new();
    let mut spec = f.spec();
    spec.members[0].display_name = " ".into();
    assert!(prepare(&f.root, spec, fork_plan()).is_err());
    let mut plan = fork_plan();
    plan.tasks[0].title = " ".into();
    assert!(prepare(&f.root, f.spec(), plan).is_err());
    let original = f.prepare();
    let path = f
        .root
        .join("team-runs")
        .join(format!("{}.json", original.id));
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy["schemaVersion"] = json!(1);
    for member in legacy["spec"]["members"].as_array_mut().unwrap() {
        member.as_object_mut().unwrap().remove("displayName");
    }
    for record in legacy["tasks"].as_array_mut().unwrap() {
        record["task"].as_object_mut().unwrap().remove("title");
    }
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let migrated = get(&f.root, &original.id).unwrap();
    assert_eq!(migrated.schema_version, 3);
    assert_eq!(migrated.revision, original.revision + 1);
    assert_eq!(migrated.spec.members[0].display_name, "research");
    assert_eq!(migrated.tasks[0].task.title, "a");
    assert_eq!(
        get(&f.root, &original.id).unwrap().revision,
        migrated.revision
    );
    legacy["schemaVersion"] = json!(2);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    assert!(get(&f.root, &original.id).is_err());
    legacy["schemaVersion"] = json!(1);
    legacy["tasks"][0]["task"] = json!(42);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    assert!(get(&f.root, &original.id)
        .unwrap_err()
        .contains("Invalid legacy Team task"));
}
