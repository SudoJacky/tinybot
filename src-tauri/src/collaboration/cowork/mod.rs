use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
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

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CoworkAgentModel {
    id: String,
    title: String,
    status: String,
    goal: String,
    parent_agent_id: Option<String>,
    tool_policy: Value,
    budget: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CoworkTaskModel {
    id: String,
    title: String,
    status: String,
    assigned_agent_id: Option<String>,
    dependencies: Vec<String>,
    work_units: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CoworkArtifactModel {
    id: String,
    title: String,
    kind: String,
    owner_agent_id: Option<String>,
    content: Value,
    created_at: String,
}

impl Default for CoworkStore {
    fn default() -> Self {
        Self {
            version: 2,
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
        for session in &mut sessions {
            recover_interrupted_session(session);
        }
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
        let id = unique_id("cowork");
        let lead_agent = CoworkAgentModel {
            id: "agent-lead".to_string(),
            title: "Lead".to_string(),
            status: "ready".to_string(),
            goal: goal.clone(),
            parent_agent_id: None,
            tool_policy: body
                .get("tool_policy")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            budget: serde_json::json!({ "tokens": body.get("max_tokens").cloned().unwrap_or(Value::Null) }),
        };
        let first_task = CoworkTaskModel {
            id: "task-root".to_string(),
            title: goal.clone(),
            status: "ready".to_string(),
            assigned_agent_id: Some(lead_agent.id.clone()),
            dependencies: Vec::new(),
            work_units: vec![serde_json::json!({
                "id": "work-root",
                "task_id": "task-root",
                "status": "ready",
                "title": goal,
                "attempts": 0,
                "agent_id": lead_agent.id
            })],
        };
        let created_event = cowork_event(
            &format!("event-{id}-created"),
            "session.created",
            &format!("Created cowork session '{title}'"),
            "user",
            timestamp.clone(),
            serde_json::json!({ "goal": first_task.title }),
        );
        let session = serde_json::json!({
            "id": id,
            "title": title,
            "goal": first_task.title,
            "status": "active",
            "workflow_mode": string_field(&body, "workflow_mode").unwrap_or_else(|| "swarm".to_string()),
            "current_branch_id": "branch-main",
            "current_focus_task": first_task.id,
            "workspace_dir": string_field(&body, "workspace_dir").unwrap_or_default(),
            "agents": { "agent-lead": lead_agent },
            "tasks": { "task-root": first_task },
            "threads": {},
            "messages": {},
            "mailbox": { "agent-lead": [] },
            "events": [created_event],
            "delegated_events": [],
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
            "swarm_plan": {
                "status": "ready",
                "work_units": ["work-root"],
                "reducer_gate": "pending",
                "reviewer_gate": "pending",
                "evaluation_gate": "pending"
            },
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
                "approval_required": body.get("approval_required").cloned().unwrap_or(Value::Bool(false)),
                "retry_limit": body.get("retry_limit").cloned().unwrap_or_else(|| serde_json::json!(2))
            },
            "stop_reason": "",
            "blueprint": body.get("blueprint").cloned().unwrap_or_else(|| serde_json::json!({})),
            "blueprint_diagnostics": [],
            "runtime_state": {
                "owner": "rust",
                "scheduler": "ready",
                "recovered": false,
                "agent_runtime": "rust"
            },
            "created_at": timestamp,
            "updated_at": timestamp,
            "rounds": 0,
            "no_progress_rounds": 0
        });
        store.event_records.push(event_record(
            &id,
            "session.created",
            timestamp,
            session["events"][0].clone(),
        ));
        store.sessions.push(session.clone());
        self.write_store(&store)?;
        Ok(session)
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<Value>, String> {
        let mut store = self.read_store()?;
        let Some(index) = find_session_index(&store, session_id) else {
            return Ok(None);
        };
        recover_interrupted_session(&mut store.sessions[index]);
        let session = store.sessions[index].clone();
        self.write_store(&store)?;
        Ok(Some(session))
    }

    pub fn delete_session(&self, session_id: &str) -> Result<Value, String> {
        let mut store = self.read_store()?;
        let before = store.sessions.len();
        store
            .sessions
            .retain(|session| session.get("id").and_then(Value::as_str) != Some(session_id));
        let deleted = store.sessions.len() != before;
        if deleted {
            store.event_records.push(event_record(
                session_id,
                "session.deleted",
                now_timestamp(),
                serde_json::json!({ "session_id": session_id }),
            ));
            self.write_store(&store)?;
        }
        Ok(serde_json::json!({ "ok": deleted, "deleted": deleted, "runtime": "rust" }))
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
                "swarm_plan": session["swarm_plan"],
            }),
            "trace" => serde_json::json!({
                "events": session["events"],
                "delegated_events": session["delegated_events"],
                "trace_spans": session["trace_spans"],
                "agent_steps": session["agent_steps"],
            }),
            "dag" => {
                serde_json::json!({ "tasks": session["tasks"], "swarm_plan": session["swarm_plan"] })
            }
            "artifacts" => serde_json::json!({
                "artifacts": session["artifacts"],
                "sensitive_artifacts": session["sensitive_artifacts"],
            }),
            "organization" => serde_json::json!({ "agents": session["agents"] }),
            "queues" => serde_json::json!({ "mailbox": session["mailbox"] }),
            "branches" => {
                serde_json::json!({ "branches": session["branches"], "current_branch_id": session["current_branch_id"] })
            }
            "blueprint" => serde_json::json!({
                "blueprint": session["blueprint"],
                "diagnostics": session["blueprint_diagnostics"],
            }),
            _ => session,
        };
        Ok(Some(value))
    }

    pub fn validate_blueprint(&self, body: Value, preview: bool) -> Result<Value, String> {
        let title = string_field(&body, "title")
            .or_else(|| string_field(&body, "name"))
            .unwrap_or_else(|| "Cowork blueprint".to_string());
        Ok(serde_json::json!({
            "ok": true,
            "valid": true,
            "preview": preview,
            "runtime": "rust",
            "blueprint": {
                "schema_version": "cowork.blueprint.v1",
                "title": title,
                "architecture": string_field(&body, "architecture").unwrap_or_else(|| "swarm".to_string()),
                "body": body
            },
            "diagnostics": []
        }))
    }

    pub fn run_session(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            if spawn_budget_exhausted(session) {
                append_scheduler_decision(
                    session,
                    "blocked",
                    "spawn_budget_exhausted",
                    now.clone(),
                );
                append_session_event(
                    session,
                    records,
                    "budget.blocked",
                    "Spawn budget exhausted",
                    "scheduler",
                    now,
                    serde_json::json!({ "budget": session["budget_usage"], "limits": session["budget_limits"] }),
                );
                return Ok(session.clone());
            }

            increment_number_path(session, &["budget_usage", "rounds"], 1);
            let delegate = spawn_delegate(session, body, now.clone());
            append_scheduler_decision(session, "running", "rust_cowork_scheduler_dispatched", now.clone());
            append_session_event(
                session,
                records,
                "scheduler.dispatched",
                "Rust Cowork scheduler dispatched delegated work",
                "scheduler",
                now,
                serde_json::json!({ "delegate_id": delegate["delegate_id"] }),
            );
            Ok(session.clone())
        })
    }

    pub fn update_budget(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            merge_object_field(session, "budget_limits", body.clone());
            let now = now_timestamp();
            append_session_event(
                session,
                records,
                "budget.updated",
                "Cowork budget limits updated",
                "user",
                now,
                body,
            );
            Ok(session.clone())
        })
    }

    pub fn session_action(
        &self,
        session_id: &str,
        action: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            let status = match action {
                "pause" => "paused",
                "resume" => "active",
                "emergency-stop" => "interrupted",
                _ => "active",
            };
            session["status"] = Value::String(status.to_string());
            session["stop_reason"] = Value::String(if action == "emergency-stop" {
                "emergency_stop".to_string()
            } else {
                String::new()
            });
            append_session_event(
                session,
                records,
                &format!("session.{action}"),
                &format!("Cowork session action: {action}"),
                "user",
                now,
                body,
            );
            Ok(session.clone())
        })
    }

    pub fn append_message(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            let message = serde_json::json!({
                "id": format!("message-{}", now_millis()),
                "role": string_field(&body, "role").unwrap_or_else(|| "user".to_string()),
                "content": string_field(&body, "content").unwrap_or_default(),
                "created_at": now,
                "payload": body
            });
            object_field_mut(session, "messages").insert(
                message["id"].as_str().unwrap_or("message").to_string(),
                message.clone(),
            );
            append_session_event(
                session,
                records,
                "message.created",
                "Cowork message recorded",
                "user",
                now,
                message.clone(),
            );
            Ok(message)
        })
    }

    pub fn add_task(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            let task_id = string_field(&body, "id").unwrap_or_else(|| format!("task-{}", now_millis()));
            let assigned_agent_id = string_field(&body, "assigned_agent_id")
                .or_else(|| string_field(&body, "assignedAgentId"))
                .or_else(|| Some("agent-lead".to_string()));
            let task = CoworkTaskModel {
                id: task_id.clone(),
                title: string_field(&body, "title")
                    .or_else(|| string_field(&body, "goal"))
                    .unwrap_or_else(|| "Cowork task".to_string()),
                status: "ready".to_string(),
                assigned_agent_id,
                dependencies: body
                    .get("dependencies")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                work_units: vec![serde_json::json!({
                    "id": format!("work-{task_id}"),
                    "task_id": task_id,
                    "status": "ready",
                    "title": body.get("title").cloned().unwrap_or_else(|| serde_json::json!("Cowork task")),
                    "attempts": 0
                })],
            };
            object_field_mut(session, "tasks").insert(task.id.clone(), serde_json::to_value(&task).unwrap());
            session["current_focus_task"] = Value::String(task.id.clone());
            append_session_event(
                session,
                records,
                "task.created",
                &format!("Cowork task created: {}", task.title),
                "user",
                now,
                serde_json::to_value(&task).unwrap(),
            );
            Ok(serde_json::to_value(task).unwrap())
        })
    }

    pub fn task_action(
        &self,
        session_id: &str,
        task_id: &str,
        action: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let status = match action {
                "assign" => "ready",
                "retry" => "ready",
                "review" => "reviewing",
                _ => "ready",
            };
            let assigned = string_field(&body, "assigned_agent_id")
                .or_else(|| string_field(&body, "assignedAgentId"));
            if let Some(task) = object_field_mut(session, "tasks").get_mut(task_id) {
                task["status"] = Value::String(status.to_string());
                if let Some(assigned) = assigned {
                    task["assigned_agent_id"] = Value::String(assigned);
                }
            }
            let now = now_timestamp();
            append_session_event(
                session,
                records,
                &format!("task.{action}"),
                &format!("Cowork task action: {action}"),
                "user",
                now,
                serde_json::json!({ "task_id": task_id, "body": body }),
            );
            Ok(session.clone())
        })
    }

    pub fn work_unit_action(
        &self,
        session_id: &str,
        work_unit_id: &str,
        action: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let status = match action {
                "retry" => "ready",
                "skip" => "skipped",
                "cancel" => "cancelled",
                _ => "ready",
            };
            for task in object_field_mut(session, "tasks").values_mut() {
                if let Some(work_units) = task.get_mut("work_units").and_then(Value::as_array_mut) {
                    for work_unit in work_units {
                        if work_unit.get("id").and_then(Value::as_str) == Some(work_unit_id) {
                            work_unit["status"] = Value::String(status.to_string());
                            increment_number_field(
                                work_unit,
                                "attempts",
                                if action == "retry" { 1 } else { 0 },
                            );
                        }
                    }
                }
            }
            let now = now_timestamp();
            append_session_event(
                session,
                records,
                &format!("work_unit.{action}"),
                &format!("Cowork work-unit action: {action}"),
                "user",
                now,
                serde_json::json!({ "work_unit_id": work_unit_id, "body": body }),
            );
            Ok(session.clone())
        })
    }

    pub fn select_branch(
        &self,
        session_id: &str,
        branch_id: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            session["current_branch_id"] = Value::String(branch_id.to_string());
            let now = now_timestamp();
            append_session_event(
                session,
                records,
                "branch.selected",
                "Cowork branch selected",
                "user",
                now,
                serde_json::json!({ "branch_id": branch_id, "body": body }),
            );
            Ok(session.clone())
        })
    }

    pub fn derive_branch(
        &self,
        session_id: &str,
        source_branch_id: Option<&str>,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            let branch_id = string_field(&body, "branch_id")
                .or_else(|| string_field(&body, "branchId"))
                .unwrap_or_else(|| format!("branch-{}", now_millis()));
            object_field_mut(session, "branches").insert(branch_id.clone(), serde_json::json!({
                "id": branch_id,
                "title": string_field(&body, "title").unwrap_or_else(|| "Derived branch".to_string()),
                "architecture": string_field(&body, "target_architecture").or_else(|| string_field(&body, "targetArchitecture")).unwrap_or_else(|| "swarm".to_string()),
                "status": "active",
                "source_branch_id": source_branch_id,
                "created_at": now,
                "updated_at": now,
                "runtime_state": { "owner": "rust" },
                "completion_decision": {},
                "branch_result": null
            }));
            append_session_event(
                session,
                records,
                "branch.derived",
                "Cowork branch derived",
                "user",
                now,
                serde_json::json!({ "branch_id": branch_id, "source_branch_id": source_branch_id }),
            );
            Ok(session.clone())
        })
    }

    pub fn select_branch_result(
        &self,
        session_id: &str,
        branch_id: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            if let Some(branch) = object_field_mut(session, "branches").get_mut(branch_id) {
                branch["branch_result"] = body.clone();
                branch["completion_decision"] =
                    serde_json::json!({ "selected": true, "selected_at": now });
            }
            append_session_event(
                session,
                records,
                "branch.result_selected",
                "Cowork branch result selected",
                "user",
                now,
                serde_json::json!({ "branch_id": branch_id, "body": body }),
            );
            Ok(session.clone())
        })
    }

    pub fn merge_branch_results(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            let artifact = CoworkArtifactModel {
                id: format!("artifact-branch-merge-{}", now_millis()),
                title: "Merged branch result".to_string(),
                kind: "branch_result".to_string(),
                owner_agent_id: Some("agent-lead".to_string()),
                content: body.clone(),
                created_at: now.clone(),
            };
            array_field_mut(session, "artifacts").push(serde_json::to_value(&artifact).unwrap());
            session["shared_summary"] =
                Value::String("Merged branch results are available.".to_string());
            append_session_event(
                session,
                records,
                "branch.results_merged",
                "Cowork branch results merged",
                "reducer",
                now,
                serde_json::to_value(&artifact).unwrap(),
            );
            Ok(session.clone())
        })
    }

    pub fn select_final_result(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            session["session_final_result"] = body.clone();
            session["completion_decision"] =
                serde_json::json!({ "selected": true, "selected_at": now });
            append_session_event(
                session,
                records,
                "final_result.selected",
                "Cowork final result selected",
                "reviewer",
                now,
                body,
            );
            Ok(session.clone())
        })
    }

    pub fn merge_final_result(&self, session_id: &str, body: Value) -> Result<Value, String> {
        self.update_session(session_id, |session, records| {
            let now = now_timestamp();
            session["final_draft"] = Value::String(
                string_field(&body, "final_draft")
                    .or_else(|| string_field(&body, "content"))
                    .unwrap_or_else(|| "Merged final result".to_string()),
            );
            session["status"] = Value::String("completed".to_string());
            session["session_final_result"] = body.clone();
            append_session_event(
                session,
                records,
                "final_result.merged",
                "Cowork final result merged",
                "reviewer",
                now,
                body,
            );
            Ok(session.clone())
        })
    }

    pub fn agent_activity(
        &self,
        session_id: &str,
        agent_id: &str,
        limit: usize,
    ) -> Result<Value, String> {
        let Some(session) = self.get_session(session_id)? else {
            return Ok(serde_json::json!({ "activity": [], "agent_id": agent_id }));
        };
        let mut activity = session
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|event| {
                event.get("actor_id").and_then(Value::as_str) == Some(agent_id)
                    || event
                        .get("data")
                        .and_then(|data| data.get("agent_id"))
                        .and_then(Value::as_str)
                        == Some(agent_id)
                    || event
                        .get("data")
                        .and_then(|data| data.get("delegate_id"))
                        .and_then(Value::as_str)
                        == Some(agent_id)
            })
            .collect::<Vec<_>>();
        if activity.len() > limit {
            activity = activity.split_off(activity.len() - limit);
        }
        Ok(serde_json::json!({ "agent_id": agent_id, "activity": activity, "runtime": "rust" }))
    }

    pub fn observation(&self, session_id: &str, detail_ref: &str) -> Result<Value, String> {
        let Some(session) = self.get_session(session_id)? else {
            return Ok(serde_json::json!({ "detail_ref": detail_ref, "observation": null }));
        };
        Ok(serde_json::json!({
            "detail_ref": detail_ref,
            "observation": session
                .get("observation_details")
                .and_then(|details| details.get(detail_ref))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({
                    "summary": "No detailed observation has been recorded.",
                    "runtime": "rust"
                }))
        }))
    }

    fn update_session<F>(&self, session_id: &str, update: F) -> Result<Value, String>
    where
        F: FnOnce(&mut Value, &mut Vec<Value>) -> Result<Value, String>,
    {
        let mut store = self.read_store()?;
        let Some(index) = find_session_index(&store, session_id) else {
            return Err(format!("cowork session not found: {session_id}"));
        };
        recover_interrupted_session(&mut store.sessions[index]);
        let mut records = Vec::new();
        let result = update(&mut store.sessions[index], &mut records)?;
        store.sessions[index]["updated_at"] = Value::String(now_timestamp());
        store.event_records.extend(records);
        self.write_store(&store)?;
        Ok(result)
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

fn spawn_delegate(session: &mut Value, body: Value, now: String) -> Value {
    increment_number_path(session, &["budget_usage", "spawned_agents"], 1);
    let delegate_id = string_field(&body, "delegate_id")
        .or_else(|| string_field(&body, "delegateId"))
        .unwrap_or_else(|| format!("delegate-{}", now_millis()));
    let agent = CoworkAgentModel {
        id: delegate_id.clone(),
        title: string_field(&body, "title").unwrap_or_else(|| "Delegated agent".to_string()),
        status: "completed".to_string(),
        goal: string_field(&body, "goal")
            .or_else(|| {
                session
                    .get("goal")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "Cowork delegated work".to_string()),
        parent_agent_id: Some("agent-lead".to_string()),
        tool_policy: session["policy"]["tool_policy"].clone(),
        budget: serde_json::json!({ "tokens": session["budget_limits"]["max_tokens"] }),
    };
    object_field_mut(session, "agents")
        .insert(agent.id.clone(), serde_json::to_value(&agent).unwrap());
    object_field_mut(session, "mailbox").insert(
        delegate_id.clone(),
        serde_json::json!([{
            "id": format!("mail-{delegate_id}"),
            "from": "agent-lead",
            "to": delegate_id,
            "status": "delivered",
            "content": agent.goal,
            "created_at": now
        }]),
    );
    let artifact = CoworkArtifactModel {
        id: format!("artifact-{delegate_id}"),
        title: format!("{} result", agent.title),
        kind: "delegate_result".to_string(),
        owner_agent_id: Some(delegate_id.clone()),
        content: serde_json::json!({
            "final_output": string_field(&body, "final_output").or_else(|| string_field(&body, "finalOutput")).unwrap_or_else(|| "Delegated work completed.".to_string())
        }),
        created_at: now.clone(),
    };
    array_field_mut(session, "artifacts").push(serde_json::to_value(&artifact).unwrap());

    let delegated_events = [
        "agent.delegate.started",
        "agent.delegate.running",
        "agent.delegate.trace.updated",
        "agent.delegate.completed",
    ]
    .into_iter()
    .map(|event_type| {
        serde_json::json!({
            "event_type": event_type,
            "delegate_id": delegate_id,
            "agent_id": delegate_id,
            "status": if event_type.ends_with("completed") { "completed" } else { "running" },
            "title": agent.title,
            "task": agent.goal,
            "trace_ref": format!("trace-{delegate_id}"),
            "runtime": "rust",
            "created_at": now
        })
    })
    .collect::<Vec<_>>();
    for delegated_event in &delegated_events {
        array_field_mut(session, "delegated_events").push(delegated_event.clone());
    }
    session["swarm_plan"]["reducer_gate"] = Value::String("ready".to_string());
    session["swarm_plan"]["reviewer_gate"] = Value::String("ready".to_string());
    serde_json::json!({ "delegate_id": delegate_id, "events": delegated_events })
}

fn spawn_budget_exhausted(session: &Value) -> bool {
    let Some(limit) = session
        .get("budget_limits")
        .and_then(|limits| limits.get("max_spawned_agents"))
        .and_then(Value::as_i64)
    else {
        return false;
    };
    let used = session
        .get("budget_usage")
        .and_then(|usage| usage.get("spawned_agents"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    used >= limit
}

fn recover_interrupted_session(session: &mut Value) {
    if session.get("status").and_then(Value::as_str) != Some("running") {
        return;
    }
    session["status"] = Value::String("interrupted".to_string());
    session["runtime_state"]["recovered"] = Value::Bool(true);
    append_scheduler_decision(
        session,
        "interrupted",
        "rust_cowork_recovered_interrupted_session",
        now_timestamp(),
    );
}

fn append_scheduler_decision(session: &mut Value, status: &str, reason: &str, created_at: String) {
    array_field_mut(session, "scheduler_decisions").push(serde_json::json!({
        "id": format!("scheduler-{}-{}", status, now_millis()),
        "status": status,
        "reason": reason,
        "created_at": created_at
    }));
    session["runtime_state"]["scheduler"] = Value::String(status.to_string());
}

fn append_session_event(
    session: &mut Value,
    records: &mut Vec<Value>,
    event_type: &str,
    message: &str,
    actor_id: &str,
    created_at: String,
    data: Value,
) {
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("cowork-session")
        .to_string();
    let event = cowork_event(
        &format!("event-{session_id}-{}", now_millis()),
        event_type,
        message,
        actor_id,
        created_at.clone(),
        data,
    );
    array_field_mut(session, "events").push(event.clone());
    records.push(event_record(&session_id, event_type, created_at, event));
}

fn cowork_event(
    id: &str,
    event_type: &str,
    message: &str,
    actor_id: &str,
    created_at: String,
    data: Value,
) -> Value {
    serde_json::json!({
        "id": id,
        "type": event_type,
        "message": message,
        "actor_id": actor_id,
        "created_at": created_at,
        "data": data
    })
}

fn event_record(session_id: &str, event_type: &str, created_at: String, payload: Value) -> Value {
    serde_json::json!({
        "session_id": session_id,
        "type": event_type,
        "created_at": created_at,
        "payload": payload
    })
}

fn merge_object_field(session: &mut Value, field: &str, patch: Value) {
    let target = object_field_mut(session, field);
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn object_field_mut<'a>(value: &'a mut Value, field: &str) -> &'a mut Map<String, Value> {
    if !value.get(field).is_some_and(Value::is_object) {
        value[field] = serde_json::json!({});
    }
    value[field]
        .as_object_mut()
        .expect("field should be object")
}

fn array_field_mut<'a>(value: &'a mut Value, field: &str) -> &'a mut Vec<Value> {
    if !value.get(field).is_some_and(Value::is_array) {
        value[field] = serde_json::json!([]);
    }
    value[field].as_array_mut().expect("field should be array")
}

fn increment_number_path(value: &mut Value, path: &[&str], amount: i64) {
    if path.is_empty() {
        return;
    }
    let mut cursor = value;
    for segment in &path[..path.len() - 1] {
        cursor = &mut cursor[*segment];
    }
    increment_number_field(cursor, path[path.len() - 1], amount);
}

fn increment_number_field(value: &mut Value, field: &str, amount: i64) {
    let current = value.get(field).and_then(Value::as_i64).unwrap_or(0);
    value[field] = serde_json::json!(current + amount);
}

fn find_session_index(store: &CoworkStore, session_id: &str) -> Option<usize> {
    store
        .sessions
        .iter()
        .position(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
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

fn unique_id(prefix: &str) -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "{prefix}-{}-{}",
        now_millis(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "cowork_tests.rs"]
mod tests;
