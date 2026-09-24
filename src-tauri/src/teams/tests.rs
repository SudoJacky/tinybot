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
                json!({"summary":" ","artifacts":["evidence.txt"],"unresolved":""}),
            ),
            ("a", 2) => {
                assert!(
                    messages.contains("nonblank"),
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
            response_items: if context.responses_input_items.is_some() {
                vec![json!({
                    "type": "function_call",
                    "id": format!("item-board-{task}-{step}"),
                    "call_id": format!("board-{task}-{step}"),
                    "name": name,
                    "arguments": arguments.to_string(),
                })]
            } else {
                vec![]
            },
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

#[tokio::test]
async fn chat_recruitment_appends_live_dag_and_notifications_have_a_cursor() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = prepare_owned(
        &f.root,
        f.spec(),
        TeamPlan {
            tasks: vec![task("a", "research", &[])],
            final_task_id: String::new(),
        },
        new_run_id(),
        Some("parent".into()),
    )
    .unwrap();
    let (executor, mut receiver) = controlled();
    let (_, handle) = runtime::start(&f.root, start_input(&run), executor).unwrap();
    let (_, finish_a) = next(&mut receiver).await;
    let (reply, receive) = oneshot::channel();
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    {
        let active = store::lock().unwrap();
        let control = active.get(&path).unwrap();
        control
            .recruitment
            .lock()
            .unwrap()
            .push(runtime::RecruitRequest {
                input: runtime::Recruitment {
                    members: vec![],
                    tasks: vec![task("b", "review", &["a"])],
                },
                reply,
            });
        control.recruited.notify_one();
    }
    let appended = tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(appended.tasks.len(), 2);
    assert!(
        receiver.try_recv().is_err(),
        "dependent task must wait for committed output"
    );
    success(finish_a, "first committed result");
    let (job, finish_b) = next(&mut receiver).await;
    assert_eq!(job.task.id, "b");
    assert_eq!(
        job.input["dependencyResults"][0]["summary"],
        "first committed result"
    );
    let saved = get(&f.root, &run.id).unwrap();
    let page = coordinator::snapshot(&saved, 0).unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    let cursor = page["afterSequence"].as_u64().unwrap();
    assert!(coordinator::snapshot(&saved, cursor).unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    success(finish_b, "second committed result");
    let done = handle.await.unwrap().unwrap();
    assert_eq!(done.status, RunStatus::Completed);
    let page = coordinator::snapshot(&done, cursor).unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["messages"][0]["summary"], "second committed result");
    let mut bad = done.clone();
    assert!(runtime::append_recruitment(
        &mut bad,
        runtime::Recruitment {
            members: vec![],
            tasks: vec![task("a", "research", &[])]
        }
    )
    .is_err());
    assert_eq!(bad.tasks.len(), done.tasks.len());
    assert!(runtime::append_recruitment(
        &mut bad,
        runtime::Recruitment {
            members: vec![],
            tasks: vec![task("c", "review", &["d"]), task("d", "research", &["c"])]
        }
    )
    .is_err());
    runtime::append_recruitment(
        &mut bad,
        runtime::Recruitment {
            members: vec![TeamMember {
                id: "new-member".into(),
                display_name: "New specialist".into(),
                instructions: "Verify sources".into(),
                model: None,
            }],
            tasks: vec![task("c", "new-member", &["b"])],
        },
    )
    .unwrap();
    assert_eq!(bad.tasks.len(), 3);
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
    defer_cancellation: bool,
}
#[async_trait]
impl TaskExecutor for ControlledExecutor {
    async fn execute(&self, job: TaskJob, cancellation: CancellationToken) -> TaskOutcome {
        let (send, receive) = oneshot::channel();
        self.started.send((job, send)).unwrap();
        tokio::select! {
            result = receive => result.unwrap(),
            _ = cancellation.cancelled(), if !self.defer_cancellation => TaskOutcome::Cancelled,
        }
    }
}
fn controlled() -> (
    Arc<ControlledExecutor>,
    mpsc::UnboundedReceiver<(TaskJob, oneshot::Sender<TaskOutcome>)>,
) {
    let (started, receiver) = mpsc::unbounded_channel();
    (
        Arc::new(ControlledExecutor {
            started,
            defer_cancellation: false,
        }),
        receiver,
    )
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

#[tokio::test]
async fn team_handoff_regression_wait_has_no_empty_timeout() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = prepare_owned(
        &f.root,
        f.spec(),
        TeamPlan {
            tasks: vec![task("a", "research", &[])],
            final_task_id: String::new(),
        },
        new_run_id(),
        Some("parent".into()),
    )
    .unwrap();
    let (executor, mut rx) = controlled();
    let (_, handle) = runtime::start(&f.root, start_input(&run), executor).unwrap();
    let (_, done) = next(&mut rx).await;
    let wait = coordinator::wait_for_results(
        &f.root,
        "parent",
        &run.id,
        0,
        coordinator::WaitFor::NextResult,
        std::future::pending(),
    );
    tokio::pin!(wait);
    let premature = tokio::time::timeout(Duration::from_secs(31), &mut wait).await;
    // Always drain the scheduler before assertions/fixture cleanup, including the red case.
    success(done, "committed result");
    handle.await.unwrap().unwrap();
    assert!(
        premature.is_err(),
        "unchanged state must not return to the model: {premature:?}"
    );
    let result = tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["messages"][0]["summary"], "committed result");
}

fn prepare_wait_run(f: &Fixture) -> TeamRun {
    prepare_owned(
        &f.root,
        f.spec(),
        TeamPlan {
            tasks: vec![task("a", "research", &[]), task("b", "review", &[])],
            final_task_id: String::new(),
        },
        new_run_id(),
        Some("parent".into()),
    )
    .unwrap()
}

#[tokio::test]
async fn team_wait_filters_progress_and_preserves_results_in_both_modes() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = prepare_wait_run(&f);
    let (executor, mut rx) = controlled();
    let (_, handle) = runtime::start(&f.root, start_input(&run), executor).unwrap();
    let (_, a) = next(&mut rx).await;
    let (_, b) = next(&mut rx).await;
    let next_result = coordinator::wait_for_results(
        &f.root,
        "parent",
        &run.id,
        0,
        coordinator::WaitFor::NextResult,
        std::future::pending(),
    );
    let all = coordinator::wait_for_results(
        &f.root,
        "parent",
        &run.id,
        0,
        coordinator::WaitFor::AllTasks,
        std::future::pending(),
    );
    tokio::pin!(next_result, all);
    assert!(futures_util::poll!(&mut next_result).is_pending());
    assert!(futures_util::poll!(&mut all).is_pending());
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    store::lock()
        .unwrap()
        .get(&path)
        .unwrap()
        .changed
        .notify_waiters();
    assert!(
        futures_util::poll!(&mut next_result).is_pending(),
        "progress alone is not a handoff"
    );
    assert!(futures_util::poll!(&mut all).is_pending());
    success(a, "first result");
    let first = tokio::time::timeout(Duration::from_secs(5), next_result)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["messages"][0]["summary"], "first result");
    assert_eq!(first["status"], "running");
    assert!(
        futures_util::poll!(&mut all).is_pending(),
        "all_tasks must not consume partial results"
    );
    let cursor = first["afterSequence"].as_u64().unwrap();
    let second = coordinator::wait_for_results(
        &f.root,
        "parent",
        &run.id,
        cursor,
        coordinator::WaitFor::NextResult,
        std::future::pending(),
    );
    tokio::pin!(second);
    assert!(
        futures_util::poll!(&mut second).is_pending(),
        "consumed results must not repeat"
    );
    success(b, "second result");
    handle.await.unwrap().unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second["messages"].as_array().unwrap().len(), 1);
    assert_eq!(second["messages"][0]["summary"], "second result");
    let all = tokio::time::timeout(Duration::from_secs(5), all)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(all["status"], "completed");
    assert_eq!(all["messages"].as_array().unwrap().len(), 2);
    assert!(coordinator::wait_for_results(
        &f.root,
        "other-parent",
        &run.id,
        0,
        coordinator::WaitFor::NextResult,
        std::future::pending()
    )
    .await
    .unwrap_err()
    .contains("another conversation"));
}

#[tokio::test]
async fn team_wait_cancellation_and_scheduler_exit_wake_without_results() {
    let _serial = EXECUTION_TESTS.lock().await;
    for interrupted in [false, true] {
        let f = Fixture::new();
        let run = prepare_wait_run(&f);
        let (executor, mut rx) = controlled();
        let (_, handle) = runtime::start(&f.root, start_input(&run), executor).unwrap();
        let (_, _a) = next(&mut rx).await;
        let (_, _b) = next(&mut rx).await;
        let cancel = CancellationToken::new();
        let wait = coordinator::wait_for_results(
            &f.root,
            "parent",
            &run.id,
            0,
            coordinator::WaitFor::AllTasks,
            cancel.cancelled(),
        );
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        if interrupted {
            handle.abort();
            assert!(handle.await.unwrap_err().is_cancelled());
            let result = tokio::time::timeout(Duration::from_secs(5), wait)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result["status"], "interrupted");
            assert!(result["error"].as_str().unwrap().contains("interrupted"));
        } else {
            cancel.cancel();
            let error = tokio::time::timeout(Duration::from_secs(5), wait)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error, "Team wait cancelled");
            let current = get(&f.root, &run.id).unwrap();
            control(&f.root, control_input(&current, TeamAction::Cancel, &[])).unwrap();
            handle.await.unwrap().unwrap();
            let result = coordinator::wait_for_results(
                &f.root,
                "parent",
                &run.id,
                0,
                coordinator::WaitFor::NextResult,
                std::future::pending(),
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "cancelled");
        }
    }
}

#[tokio::test]
async fn team_wait_reports_failure_before_siblings_finish_draining() {
    let _serial = EXECUTION_TESTS.lock().await;
    let f = Fixture::new();
    let run = prepare_wait_run(&f);
    let (started, mut rx) = mpsc::unbounded_channel();
    let executor = Arc::new(ControlledExecutor {
        started,
        defer_cancellation: true,
    });
    let (_, handle) = runtime::start(&f.root, start_input(&run), executor).unwrap();
    let (_, a) = next(&mut rx).await;
    let (_, b) = next(&mut rx).await;
    let wait = coordinator::wait_for_results(
        &f.root,
        "parent",
        &run.id,
        0,
        coordinator::WaitFor::AllTasks,
        std::future::pending(),
    );
    tokio::pin!(wait);
    assert!(futures_util::poll!(&mut wait).is_pending());
    assert!(a
        .send(TaskOutcome::Failed("source unavailable".into()))
        .is_ok());
    let result = tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["status"], "running");
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("source unavailable"));
    assert!(result["messages"].as_array().unwrap().is_empty());
    assert!(
        !handle.is_finished(),
        "failure must wake the parent before cleanup completes"
    );
    assert!(b.send(TaskOutcome::Cancelled).is_ok());
    assert_eq!(handle.await.unwrap().unwrap().status, RunStatus::Failed);
}

#[test]
fn team_handoff_regression_accepts_and_delivers_full_text() {
    use crate::protocol::capability::default_desktop_capability_policy;
    let f = Fixture::new();
    let mut run = f.prepare();
    let summary = "完整结论与证据说明。".repeat(2_000);
    let unresolved = "需要进一步确认的事项。".repeat(500);
    std::fs::write(f.root.join("evidence.txt"), "published evidence").unwrap();
    let mut message = board::complete(
        &f.root,
        default_desktop_capability_policy(),
        json!({
            "summary": summary, "unresolved": unresolved, "artifacts": ["evidence.txt"],
        }),
    )
    .expect("long summaries must not be rejected");
    message.sequence = 3;
    run.tasks[0].status = TaskStatus::Succeeded;
    run.tasks[0].attempts.push(model::TeamAttempt {
        thread_id: "entry-a".into(),
        turn_id: "turn-a".into(),
        status: TaskStatus::Succeeded,
        started_at: store::now(),
        finished_at: Some(store::now()),
        output: Some(summary.clone()),
        message: Some(message),
        error: None,
    });
    let path = store::path(&store::directory(&f.root).unwrap(), &run.id).unwrap();
    store::save(&path, &mut run).unwrap();
    let saved = get(&f.root, &run.id).unwrap();
    let mut dependent = task("next", "review", &["a"]);
    dependent.title = "Use the published result".into();
    let dependencies = board::dependencies(&saved, &dependent);
    let notification = coordinator::snapshot(&saved, 0).unwrap();
    let read = board::read(&saved, "entry-a", 0, board::READ_BYTES).unwrap();
    for delivered in [
        &dependencies[0],
        &notification["messages"][0],
        &read["message"],
    ] {
        assert_eq!(delivered["summary"], summary);
        assert_eq!(delivered["unresolved"], unresolved);
        assert_eq!(delivered["artifacts"][0]["path"], "evidence.txt");
        assert_eq!(
            delivered["artifacts"][0]["sha256"].as_str().unwrap().len(),
            64
        );
    }
    assert!(
        !notification.to_string().contains("published evidence"),
        "file contents remain lazy"
    );
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
        json!({"summary":"  ","artifacts":[],"unresolved":""}),
        json!({"summary":"x","artifacts":[],"unresolved":"","author":"forged"}),
    ] {
        assert!(board::complete(&f.root, default_desktop_capability_policy(), args).is_err());
    }
}

#[test]
fn board_delivers_all_dependency_summaries_and_migrates_legacy_output_by_reference() {
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
        63 * 1024
    );
    assert!(deps
        .iter()
        .all(|d| d["unresolved"] == "" && d["artifacts"] == json!([])));
    assert!(deps.iter().all(|d| d.get("output").is_none()));
    let mut cursor = 0;
    let mut delivered = vec![];
    loop {
        let page = coordinator::snapshot(&run, cursor).unwrap();
        delivered.extend(
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["entryId"].as_str().unwrap().to_owned()),
        );
        let next = page["afterSequence"].as_u64().unwrap();
        assert!(next > cursor);
        cursor = next;
        if page["hasMore"] == false {
            break;
        }
    }
    assert_eq!(delivered.len(), 63);
    delivered.sort();
    delivered.dedup();
    assert_eq!(
        delivered.len(),
        63,
        "paging must neither skip nor duplicate handoffs"
    );
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
    assert_native_executor_persistence("chat_completions").await;
}

#[tokio::test]
async fn native_executor_persists_responses_completion() {
    assert_native_executor_persistence("responses").await;
}

struct ChatTeamProvider {
    root: PathBuf,
    recruited: std::sync::atomic::AtomicBool,
    clarify: std::sync::atomic::AtomicBool,
    verify_file: std::sync::atomic::AtomicBool,
}
impl crate::agent::runtime::test_support::BlockingTestProvider for ChatTeamProvider {
    fn complete(
        &self,
        context: &crate::agent::runtime::AgentTurnContext,
    ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
        use crate::agent::runtime::{NativeAgentProviderResponse, NativeAgentToolCall};
        let response = |name: &str, args: serde_json::Value| {
            let id = format!("{}-{name}", context.turn_id);
            NativeAgentProviderResponse {
                final_content: String::new(),
                reasoning_delta: None,
                usage: None,
                response_items: if context.api_mode.as_deref() == Some("responses") {
                    vec![
                        json!({"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":name,"arguments":args.to_string()}),
                    ]
                } else {
                    vec![]
                },
                tool_calls: vec![NativeAgentToolCall {
                    id,
                    name: name.into(),
                    arguments_json: args.to_string(),
                    result: json!({}),
                }],
            }
        };
        if context.metadata.get("teamTaskId").is_some() {
            assert!(context.tool_execution_target("team.recruit").is_none());
            return Ok(response(
                "team.complete_task",
                json!({"summary":"VERIFIED_EMPLOYEE_RESULT","artifacts":[],"unresolved":""}),
            ));
        }
        assert!(context.tool_execution_target("team.recruit").is_some());
        assert!(context
            .system_instruction_prompt()
            .unwrap()
            .contains("You are the coordinator"));
        assert_eq!(
            context.settings.working_directory.as_deref(),
            Some(self.root.join("selected-workspace").as_path())
        );
        assert_eq!(context.settings.mcp_enabled, Some(false));
        assert_eq!(context.settings.model, "selected-model");
        if self
            .clarify
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(response(
                "request_user_input",
                json!({"title":"Choose scope","fields":[{"name":"scope","type":"text","label":"Scope","required":true}]}),
            ));
        }
        if self
            .verify_file
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(response(
                "apply_patch",
                json!({"patch":"*** Begin Patch\n*** Add File: form-workspace-proof.txt\n+restored workspace\n*** End Patch"}),
            ));
        }
        let messages =
            serde_json::to_string(&context.messages.to_legacy_messages().unwrap()).unwrap();
        if messages.contains("VERIFIED_EMPLOYEE_RESULT") {
            return Ok(NativeAgentProviderResponse {
                final_content: "Integrated verified research".into(),
                reasoning_delta: None,
                usage: None,
                tool_calls: vec![],
                response_items: if context.api_mode.as_deref() == Some("responses") {
                    vec![
                        json!({"type":"message","id":"final-integration","role":"assistant","content":[{"type":"output_text","text":"Integrated verified research"}]}),
                    ]
                } else {
                    vec![]
                },
            });
        }
        if !self
            .recruited
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            Ok(response(
                "team.recruit",
                json!({"goal":"Find evidence", "members":[{"id":"researcher","displayName":"Researcher","instructions":"Find and verify evidence"}],"tasks":[{"id":"research","title":"Research evidence","memberId":"researcher","instructions":"Return verified findings","dependencies":[]}]}),
            ))
        } else {
            let run = list(&self.root)?.pop().ok_or("Missing recruited team")?;
            Ok(response(
                "team.wait",
                json!({"runId":run.id,"afterSequence":0}),
            ))
        }
    }
}

#[tokio::test]
async fn chat_team_recruits_waits_and_continues_without_importing_worker_history() {
    assert_chat_team(false, "chat_completions").await;
}

#[tokio::test]
async fn chat_team_recruits_after_form_preserving_execution_context() {
    assert_chat_team(true, "chat_completions").await;
}

#[tokio::test]
async fn chat_team_responses_recruits_after_form_preserving_execution_context() {
    assert_chat_team(true, "responses").await;
}

async fn assert_chat_team(clarify: bool, api_mode: &str) {
    let _serial = EXECUTION_TESTS.lock().await;
    use crate::agent::bridge::{
        execute_thread_turn_with_services, SubmitThreadTurnInput, TestApplicationServices,
    };
    use crate::agent::runtime::NativeAgentRuntimeServices;
    let f = Fixture::new();
    let selected_workspace = f.root.join("selected-workspace");
    std::fs::create_dir(&selected_workspace).unwrap();
    let threads = crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
        f.root.clone(),
        f.root.clone(),
        crate::protocol::capability::default_desktop_capability_policy(),
    );
    let config = json!({"agents":{"defaults":{"provider":"fixture","model":"fixture-model"}},"providers":{"fixture":{"apiMode":api_mode,"responses":[{"content":"fixture"}]}}});
    crate::rpc::call_rust_state_service(&threads, config.clone(), crate::protocol::WorkerRequest::new("create", "create", "thread.create", json!({"threadId":"coordinator", "title":"Research coordinator", "metadata":{"workingDirectory":selected_workspace}})), "Create coordinator").unwrap();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ChatTeamProvider {
            root: f.root.clone(),
            recruited: Default::default(),
            clarify: std::sync::atomic::AtomicBool::new(clarify),
            verify_file: std::sync::atomic::AtomicBool::new(clarify),
        }),
        Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    let result = execute_thread_turn_with_services(services.clone(),
        SubmitThreadTurnInput {thread_id:Some("coordinator".into()),input:json!({"role":"user","content":"@team research evidence","clientEventId":"chat-team-input"}),spec:json!({"turnId":"coordinator-turn","model":"selected-model","mcpEnabled":false})},
        f.root.clone(),config,None,
    ).await.unwrap();
    if clarify {
        assert_eq!(result.result.stop_reason.as_str(), "awaiting_form");
        // Use the durable checkpoint lookup, as desktop submission does after a pause.
        let resumed = crate::agent::bridge::submit_thread_form_with_services(services,
            crate::agent::bridge::SubmitThreadFormInput {
                command_id: "submit-team-scope".into(), thread_id: "coordinator".into(),
                form_id: "user-input:coordinator-turn-request_user_input".into(), source: json!({}), target: json!({}),
                values: json!({"scope":"research"}), action: None,
            }, f.root.clone(), json!({"agents":{"defaults":{"model":"changed-default","provider":"fixture"}},"providers":{"fixture":{"apiMode":api_mode}}}), None
        ).await.unwrap();
        assert!(
            !resumed.to_string().contains("Team coordination requires"),
            "{resumed}"
        );
        assert!(selected_workspace
            .join("form-workspace-proof.txt")
            .is_file());
        assert!(!f.root.join("form-workspace-proof.txt").exists());
    } else {
        assert_eq!(
            result.result.stop_reason,
            crate::agent::runtime::AgentStopReason::FinalResponse,
            "{:?}",
            result.result.error
        );
    }
    let run = list(&f.root).unwrap().pop().unwrap();
    assert_eq!(run.parent_thread_id.as_deref(), Some("coordinator"));
    assert_eq!(run.tasks[0].status, TaskStatus::Succeeded);
    let history = crate::rpc::call_rust_state_service(
        &threads,
        json!({}),
        crate::protocol::WorkerRequest::new(
            "history",
            "history",
            "thread.history",
            json!({"threadId":"coordinator","limit":100}),
        ),
        "Parent history",
    )
    .unwrap()
    .to_string();
    assert!(history.contains("Integrated verified research"));
    assert!(!history.contains("Your identity:"));
    let ordinary = threads
        .begin_operation()
        .unwrap()
        .thread()
        .list_threads(Default::default())
        .unwrap();
    assert_eq!(ordinary.threads.len(), 1);
    assert!(threads
        .for_team(&run.id)
        .unwrap()
        .read_agent_thread(&run.tasks[0].attempts[0].thread_id)
        .is_ok());
    threads.shutdown().unwrap();
}

async fn assert_native_executor_persistence(api_mode: &str) {
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
            worker_options: json!({}),
            services,
            workspace_root: f.root.clone(),
            config: json!({
                "agents": {"defaults": {"provider": "fixture", "model": "fixture-model"}},
                "providers": {"fixture": {"apiMode": api_mode, "responses": [{"content": "Team fixture result"}]}}
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
    let main_list = crate::rpc::call_rust_state_service(
        &thread_store,
        json!({}),
        crate::protocol::WorkerRequest::new(
            "main-list",
            "main-list",
            "thread.list",
            json!({"includeChildThreads":true}),
        ),
        "Main list",
    )
    .unwrap();
    assert!(main_list["threads"].as_array().unwrap().is_empty());
    let thread_store = thread_store.for_team(&run.id).unwrap();
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
        assert_eq!(thread["metadata"]["extra"]["apiMode"], api_mode);
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
        let history = crate::rpc::call_rust_state_service(
            &thread_store,
            json!({}),
            crate::protocol::WorkerRequest::new(
                "team-test-history",
                "team-test-history",
                "thread.history",
                json!({"threadId": record.attempts[0].thread_id, "limit": 80}),
            ),
            "Team test history",
        )
        .unwrap();
        let completions = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| {
                message["role"] == "assistant" && message["content"] == "Team fixture result"
            })
            .collect::<Vec<_>>();
        assert_eq!(
            completions.len(),
            1,
            "completion must survive history reload"
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
