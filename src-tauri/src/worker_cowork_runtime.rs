use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct WorkerCoworkRuntime {
    root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CoworkStore {
    version: usize,
    sessions: Vec<Value>,
    event_records: Vec<Value>,
}

impl Default for CoworkStore {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: Vec::new(),
            event_records: Vec::new(),
        }
    }
}

impl WorkerCoworkRuntime {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn list_sessions(&self, include_completed: bool) -> Result<Value, String> {
        let mut sessions = self.read_store()?.sessions;
        if !include_completed {
            sessions.retain(|session| {
                session.get("status").and_then(Value::as_str) != Some("completed")
            });
        }
        Ok(serde_json::json!({
            "sessions": sessions,
            "items": sessions,
            "runtime": "rust",
        }))
    }

    pub fn create_session(&self, body: Value) -> Result<Value, String> {
        let mut store = self.read_store()?;
        let timestamp = now_timestamp();
        let goal = string_field(&body, "goal").unwrap_or_else(|| "Cowork session".to_string());
        let title = string_field(&body, "title").unwrap_or_else(|| summarize_title(&goal));
        let id = format!("cowork-{}", now_millis());
        let session = serde_json::json!({
            "id": id,
            "title": title,
            "goal": goal,
            "status": "active",
            "workflow_mode": string_field(&body, "workflow_mode").unwrap_or_else(|| "swarm".to_string()),
            "current_branch_id": "branch-main",
            "current_focus_task": "",
            "workspace_dir": string_field(&body, "workspace_dir").unwrap_or_default(),
            "agents": {},
            "tasks": {},
            "threads": {},
            "messages": {},
            "mailbox": {},
            "events": [{
                "id": format!("event-{id}-created"),
                "type": "session.created",
                "message": format!("Created cowork session '{title}'"),
                "actor_id": "user",
                "created_at": timestamp,
                "data": { "goal": goal }
            }],
            "trace_spans": [],
            "agent_steps": [],
            "observation_details": {},
            "sensitive_artifacts": {},
            "delegation_guardrails": {},
            "delegated_briefs": {},
            "delegated_tasks": {},
            "isolated_sub_agent_contexts": {},
            "sub_agent_results": {},
            "run_metrics": [],
            "scheduler_decisions": [{
                "id": format!("scheduler-{id}-created"),
                "status": "ready",
                "reason": "rust_cowork_session_created",
                "created_at": timestamp
            }],
            "branches": {
                "branch-main": {
                    "id": "branch-main",
                    "title": "Main",
                    "architecture": "swarm",
                    "status": "active",
                    "topology_reference": {},
                    "source_branch_id": null,
                    "source_stage_record_id": null,
                    "derivation_event_id": null,
                    "derivation_reason": "",
                    "inherited_context_summary": "",
                    "runtime_state": {},
                    "completion_decision": {},
                    "branch_result": null,
                    "created_at": timestamp,
                    "updated_at": timestamp
                }
            },
            "stage_records": [],
            "artifacts": [],
            "shared_memory": {},
            "shared_summary": "",
            "final_draft": "",
            "completion_decision": {},
            "session_final_result": null,
            "swarm_plan": {},
            "budget_limits": {
                "max_spawned_agents": body.get("max_spawned_agents").cloned().unwrap_or(Value::Null),
                "max_rounds": body.get("max_rounds").cloned().unwrap_or(Value::Null),
                "max_tokens": body.get("max_tokens").cloned().unwrap_or(Value::Null)
            },
            "budget_usage": {
                "spawned_agents": 0,
                "rounds": 0,
                "tokens": 0
            },
            "policy": {
                "tool_policy": body.get("tool_policy").cloned().unwrap_or_else(|| serde_json::json!({})),
                "approval_required": body.get("approval_required").cloned().unwrap_or(Value::Bool(false))
            },
            "stop_reason": "",
            "blueprint": {},
            "blueprint_diagnostics": [],
            "runtime_state": {
                "owner": "rust",
                "scheduler": "ready",
                "recovered": false
            },
            "created_at": timestamp,
            "updated_at": timestamp,
            "rounds": 0,
            "no_progress_rounds": 0
        });
        store.event_records.push(serde_json::json!({
            "session_id": id,
            "type": "session.created",
            "created_at": timestamp,
            "payload": session["events"][0].clone()
        }));
        store.sessions.push(session.clone());
        self.write_store(&store)?;
        Ok(session)
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<Value>, String> {
        Ok(self
            .read_store()?
            .sessions
            .into_iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id)))
    }

    pub fn session_view(&self, session_id: &str, view: &str) -> Result<Option<Value>, String> {
        let Some(session) = self.get_session(session_id)? else {
            return Ok(None);
        };
        let value = match view {
            "summary" => serde_json::json!({
                "id": session["id"],
                "title": session["title"],
                "goal": session["goal"],
                "status": session["status"],
                "shared_summary": session["shared_summary"],
                "final_draft": session["final_draft"],
                "completion_decision": session["completion_decision"],
                "budget_usage": session["budget_usage"],
                "budget_limits": session["budget_limits"],
                "runtime_state": session["runtime_state"],
            }),
            "graph" => serde_json::json!({
                "agents": session["agents"],
                "tasks": session["tasks"],
                "branches": session["branches"],
                "scheduler_decisions": session["scheduler_decisions"],
            }),
            "trace" => serde_json::json!({
                "events": session["events"],
                "trace_spans": session["trace_spans"],
                "agent_steps": session["agent_steps"],
            }),
            "dag" => serde_json::json!({ "tasks": session["tasks"] }),
            "artifacts" => serde_json::json!({
                "artifacts": session["artifacts"],
                "sensitive_artifacts": session["sensitive_artifacts"],
            }),
            "organization" => serde_json::json!({ "agents": session["agents"] }),
            "queues" => serde_json::json!({ "mailbox": session["mailbox"] }),
            "branches" => serde_json::json!({ "branches": session["branches"] }),
            _ => session,
        };
        Ok(Some(value))
    }

    fn store_path(&self) -> PathBuf {
        self.root.join("cowork").join("store.json")
    }

    fn read_store(&self) -> Result<CoworkStore, String> {
        let path = self.store_path();
        if !path.exists() {
            return Ok(CoworkStore::default());
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read cowork store: {error}"))?;
        serde_json::from_str(&content)
            .map_err(|error| format!("failed to parse cowork store: {error}"))
    }

    fn write_store(&self, store: &CoworkStore) -> Result<(), String> {
        let path = self.store_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create cowork store directory: {error}"))?;
        }
        write_json_pretty_atomic(&path, store)
    }
}

fn write_json_pretty_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize cowork store: {error}"))?;
    fs::write(&temp_path, content)
        .map_err(|error| format!("failed to write cowork store temp file: {error}"))?;
    fs::rename(&temp_path, path).map_err(|error| format!("failed to replace cowork store: {error}"))
}

fn summarize_title(goal: &str) -> String {
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        "Cowork session".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_timestamp() -> String {
    format!("{}Z", now_millis())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
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

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tinybot-cowork-{name}-{}", now_millis()))
    }

    struct Cleanup(PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
