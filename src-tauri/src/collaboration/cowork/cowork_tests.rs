use super::*;
use serde_json::json;

#[test]
fn creates_and_loads_cowork_session_snapshot() {
    let root = temp_root("creates-and-loads");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root);
    let created = runtime
        .create_session(json!({
            "goal": "Design a Rust backend migration",
            "title": "Rust migration",
            "max_rounds": 4
        }))
        .expect("session should create");
    let session_id = created["id"].as_str().unwrap_or_default().to_string();
    let listed = runtime.list_sessions(true).expect("sessions should list");
    let trace = runtime
        .session_view(&session_id, "trace")
        .expect("trace should load")
        .expect("session should exist");

    assert_eq!(created["title"], "Rust migration");
    assert_eq!(listed["sessions"][0]["id"], session_id);
    assert_eq!(trace["events"][0]["type"], "session.created");
    assert_eq!(created["runtime_state"]["owner"], "rust");
    assert_eq!(created["tasks"]["task-root"]["status"], "ready");
}

#[test]
fn filters_completed_sessions_by_default() {
    let root = temp_root("filters-completed");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root.clone());
    let active = runtime.create_session(json!({ "goal": "active" })).unwrap();
    let completed = runtime
        .create_session(json!({ "goal": "completed" }))
        .unwrap();
    let mut store = runtime.read_store().unwrap();
    for session in &mut store.sessions {
        if session["id"] == completed["id"] {
            session["status"] = Value::String("completed".to_string());
        }
    }
    runtime.write_store(&store).unwrap();

    let listed = runtime.list_sessions(false).unwrap();
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(listed["sessions"][0]["id"], active["id"]);
}

#[test]
fn scheduler_spawns_delegate_and_indexes_artifact_events() {
    let root = temp_root("scheduler-spawns");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root);
    let created = runtime
        .create_session(json!({ "goal": "Build Rust Cowork", "max_spawned_agents": 2 }))
        .unwrap();
    let session_id = created["id"].as_str().unwrap();

    let session = runtime
        .run_session(
            session_id,
            json!({ "delegateId": "delegate-1", "finalOutput": "done" }),
        )
        .unwrap();
    let trace = runtime.session_view(session_id, "trace").unwrap().unwrap();
    let artifacts = runtime
        .session_view(session_id, "artifacts")
        .unwrap()
        .unwrap();

    assert_eq!(session["agents"]["delegate-1"]["status"], "completed");
    assert_eq!(session["budget_usage"]["spawned_agents"], 1);
    assert_eq!(
        trace["delegated_events"][0]["event_type"],
        "agent.delegate.started"
    );
    assert_eq!(artifacts["artifacts"][0]["owner_agent_id"], "delegate-1");
}

#[test]
fn budget_policy_blocks_spawns_and_records_trace() {
    let root = temp_root("budget-blocks");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root);
    let created = runtime
        .create_session(json!({ "goal": "Stay within budget", "max_spawned_agents": 0 }))
        .unwrap();
    let session_id = created["id"].as_str().unwrap();

    let session = runtime.run_session(session_id, json!({})).unwrap();

    assert_eq!(
        session["scheduler_decisions"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["reason"],
        "spawn_budget_exhausted"
    );
    assert_eq!(session["budget_usage"]["spawned_agents"], 0);
}

#[test]
fn mutates_tasks_messages_branches_and_final_result() {
    let root = temp_root("mutates-state");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root);
    let created = runtime.create_session(json!({ "goal": "Ship" })).unwrap();
    let session_id = created["id"].as_str().unwrap();

    let task = runtime
        .add_task(
            session_id,
            json!({ "id": "task-review", "title": "Review" }),
        )
        .unwrap();
    runtime
        .task_action(
            session_id,
            "task-review",
            "assign",
            json!({ "assignedAgentId": "agent-lead" }),
        )
        .unwrap();
    runtime
        .append_message(session_id, json!({ "content": "Proceed" }))
        .unwrap();
    runtime
        .derive_branch(
            session_id,
            Some("branch-main"),
            json!({ "branchId": "branch-alt" }),
        )
        .unwrap();
    runtime
        .select_branch_result(
            session_id,
            "branch-alt",
            json!({ "resultId": "result-alt" }),
        )
        .unwrap();
    let final_session = runtime
        .merge_final_result(session_id, json!({ "content": "Final answer" }))
        .unwrap();

    assert_eq!(task["id"], "task-review");
    assert_eq!(final_session["status"], "completed");
    assert_eq!(final_session["final_draft"], "Final answer");
    assert!(final_session["messages"].as_object().unwrap().len() >= 1);
    assert_eq!(
        final_session["branches"]["branch-alt"]["completion_decision"]["selected"],
        true
    );
}

#[test]
fn recovers_interrupted_running_session() {
    let root = temp_root("recovers-interrupted");
    let _cleanup = Cleanup(root.clone());
    let runtime = WorkerCoworkRuntime::new(root.clone());
    let created = runtime
        .create_session(json!({ "goal": "Recover" }))
        .unwrap();
    let session_id = created["id"].as_str().unwrap().to_string();
    let mut store = runtime.read_store().unwrap();
    store.sessions[0]["status"] = Value::String("running".to_string());
    runtime.write_store(&store).unwrap();

    let recovered = runtime.get_session(&session_id).unwrap().unwrap();

    assert_eq!(recovered["status"], "interrupted");
    assert_eq!(recovered["runtime_state"]["recovered"], true);
}

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tinybot-cowork-{name}-{}", now_millis()))
}

struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
