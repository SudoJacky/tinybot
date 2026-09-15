use super::{execution, saved::*};
use crate::agent::bridge::TestApplicationServices;
use crate::agent::runtime::test_support::BlockingTestProvider;
use crate::agent::runtime::*;
use crate::protocol::capability::default_desktop_capability_policy;
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    store: Store,
}

struct CreateAutomationProvider {
    calls: AtomicUsize,
}

impl BlockingTestProvider for CreateAutomationProvider {
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        use crate::tools::registry::{ToolExecutionTarget, CREATE_AUTOMATION_METHOD};
        assert_eq!(
            context.tool_execution_target(CREATE_AUTOMATION_METHOD),
            Some(ToolExecutionTarget::CreateAutomation)
        );
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 1 {
            assert!(
                serde_json::to_string(&context.messages.to_provider_messages().unwrap())
                    .unwrap()
                    .contains("RFC 3339"),
                "validation errors must reach the model"
            );
        }
        let tool_calls = if call < 3 {
            let mut arguments = json!({
                "name": format!("Agent schedule {call}"),
                "instructions": "Write the project report to report.md and link it.",
                "schedule": {"repeat": "daily", "startAt": if call == 0 {"not a date"} else {"2099-09-15T09:00:00+08:00"}}
            });
            if call == 2 {
                arguments["execution"] = json!({"threadId":"current"});
            }
            vec![NativeAgentToolCall {
                id: format!("create-{call}"),
                name: CREATE_AUTOMATION_METHOD.into(),
                arguments_json: arguments.to_string(),
                result: Value::Null,
            }]
        } else {
            vec![]
        };
        Ok(NativeAgentProviderResponse {
            final_content: if tool_calls.is_empty() {
                "Schedules created".into()
            } else {
                String::new()
            },
            reasoning_delta: None,
            usage: None,
            tool_calls,
            response_items: vec![],
        })
    }
}

#[test]
fn agent_creation_tool_saves_desktop_tasks_and_resolves_current_conversation() {
    use crate::agent::bridge::{execute_thread_turn_with_services, SubmitThreadTurnInput};
    let f = Fixture::new();
    let threads = f.threads();
    let thread = crate::rpc::call_rust_state_service(
        &threads,
        f.config(),
        crate::protocol::WorkerRequest::new(
            "create-conversation",
            "trace-create-schedules",
            "thread.create",
            json!({"title":"Project schedules", "metadata":{"workingDirectory":f.workspace}}),
        ),
        "Create workspace conversation for automation tool test",
    )
    .unwrap();
    let thread_id = thread["threadId"].as_str().unwrap().to_string();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(CreateAutomationProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    let result = tauri::async_runtime::block_on(execute_thread_turn_with_services(
        services,
        SubmitThreadTurnInput {
            thread_id: Some(thread_id),
            input: json!({"role":"user", "content":"Schedule project reports, one in a new conversation and one here."}),
            spec: json!({"runtime":"rust", "stream":true, "turnId":"create-schedules", "metadata":{"workingDirectory":f.workspace}}),
        },
        f.root.clone(), f.config(), None,
    )).unwrap();
    assert_eq!(
        result.result.stop_reason.status().as_str(),
        "completed",
        "{:?}",
        result.result.error
    );
    let snapshot = execution::snapshot(&Store::new(threads.data_root()), &threads).unwrap();
    assert_eq!(snapshot.definitions.len(), 2);
    assert!(
        snapshot.runs.is_empty(),
        "creating a future task must not run it"
    );
    let new = snapshot
        .definitions
        .iter()
        .find(|d| d.name == "Agent schedule 1")
        .unwrap();
    let current = snapshot
        .definitions
        .iter()
        .find(|d| d.name == "Agent schedule 2")
        .unwrap();
    assert!(new.execution.thread_id.is_none());
    assert_eq!(
        current.execution.thread_id.as_deref(),
        Some(result.thread_id.as_str())
    );
    assert_eq!(new.model_policy, ModelPolicy::InheritDefault);
    assert_eq!(
        new.workspace_path,
        crate::workspace_registry::workspace_id(&fs::canonicalize(&f.workspace).unwrap())
    );
    let at = chrono::DateTime::parse_from_rfc3339("2099-09-15T09:00:00+08:00")
        .unwrap()
        .timestamp_millis() as u64;
    assert_eq!(new.next_run_at_ms, Some(at));
    assert!(f.store.claim_due(at - 1, Some(at - 1)).unwrap().is_empty());
    assert_eq!(
        f.store.claim_due(at, Some(at)).unwrap().len(),
        2,
        "the existing scheduler must claim agent-created tasks"
    );
    assert!(
        !fs::read_to_string(threads.data_root().join("automations/store.json"))
            .unwrap()
            .contains("secret-must-not-be-saved")
    );
}

#[test]
fn agent_creation_rejects_invalid_inputs_without_persisting_a_task() {
    let f = Fixture::new();
    let threads = f.threads();
    let valid = json!({"name":"Report", "instructions":"Inspect project", "schedule":{"repeat":"once", "startAt":"2099-09-15T09:00:00+08:00"}});
    for (patch, message) in [
        (json!({"name":" "}), "name and instructions"),
        (json!({"id":"existing-task"}), "unknown field"),
        (
            json!({"schedule":{"repeat":"hourly", "startAt":"2099-09-15T09:00:00+08:00"}}),
            "unknown variant",
        ),
        (
            json!({"schedule":{"repeat":"once", "startAt":"2099-09-15T09:00:00"}}),
            "UTC offset",
        ),
        (
            json!({"execution":{"threadId":"missing-conversation"}}),
            "Thread",
        ),
        (
            json!({"execution":{"profile":"orphan"}}),
            "provider and model",
        ),
        (
            json!({"execution":{"provider":"openai", "model":"missing-model"}}),
            "not available",
        ),
    ] {
        let mut args = valid.clone();
        args.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let error =
            super::agent_tool::create(&threads, Some(&f.workspace), "unused", &f.config(), args)
                .unwrap_err();
        assert!(
            error.to_lowercase().contains(&message.to_lowercase()),
            "expected {message}: {error}"
        );
        assert!(f.store.snapshot().unwrap().definitions.is_empty());
    }
    assert!(
        super::agent_tool::create(&threads, None, "unused", &f.config(), valid.clone())
            .unwrap_err()
            .contains("No current workspace")
    );
    let mut explicit = valid;
    explicit["workspacePath"] = json!(f.workspace);
    let saved = super::agent_tool::create(&threads, None, "unused", &f.config(), explicit).unwrap();
    assert!(saved["nextRunAt"].as_str().is_some());
    assert_eq!(f.store.snapshot().unwrap().definitions.len(), 1);
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tinybot-automations-{}", identity()));
        let workspace = root.join("project");
        fs::create_dir_all(&workspace).unwrap();
        Self {
            store: Store::new(&root.join("data")),
            root,
            workspace,
        }
    }
    fn save(&self) -> Definition {
        self.store
            .save(SaveDefinition {
                id: None,
                expected_revision: None,
                name: "Project report".into(),
                instructions: "Write the project report to report.md and link it.".into(),
                workspace_path: self.workspace.to_string_lossy().into(),
                execution: ExecutionOptions::default(),
                schedule: Default::default(),
            })
            .unwrap()
    }
    fn config(&self) -> Value {
        json!({"agents":{"defaults":{"model":"test-model","provider":"openai"}},
        "providers":{"openai":{"apiKey":"secret-must-not-be-saved","models":["test-model"]}}})
    }
    fn threads(&self) -> WorkspaceThreadStore {
        WorkspaceThreadStore::new_with_data_root(
            self.root.clone(),
            self.root.join("data"),
            default_desktop_capability_policy(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).expect("remove test fixture");
    }
}

#[test]
fn regression_general_chat_can_schedule_in_its_default_workspace() {
    let f = Fixture::new();
    let threads = f.threads();
    crate::rpc::call_rust_state_service(
        &threads,
        f.config(),
        crate::protocol::WorkerRequest::new(
            "create-general-chat",
            "trace-general",
            "thread.create",
            json!({"threadId":"general-chat", "title":"General chat"}),
        ),
        "Create general chat",
    )
    .unwrap();
    let thread = threads.read_agent_thread("general-chat").unwrap().thread;
    assert!(thread.metadata.working_directory.is_none());
    let arguments = json!({
        "name":"Default workspace test", "instructions":"Write a report in report.md",
        "schedule":{"repeat":"once", "startAt":"2099-09-15T09:00:00+08:00"},
        "execution":{"threadId":"current"}
    });
    let result = super::agent_tool::create(
        &threads,
        Some(&f.root),
        &thread.thread_id,
        &f.config(),
        arguments,
    )
    .unwrap();
    let definition: Definition = serde_json::from_value(result["definition"].clone()).unwrap();
    assert_eq!(
        definition.execution.thread_id.as_deref(),
        Some("general-chat")
    );
    execution::validate_thread(&definition.execution, &definition.workspace_path, &threads)
        .unwrap();
    assert!(execution::validate_thread(
        &definition.execution,
        &f.workspace.to_string_lossy(),
        &threads
    )
    .unwrap_err()
    .contains("different workspace"));
    let run = execution::prepare(&f.store, &definition.id, &f.config()).unwrap();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ReportProvider {
            calls: AtomicUsize::new(0),
            workspace: f.root.clone(),
            fail: false,
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        run,
        services,
        f.root.clone(),
        f.config(),
        None,
    ))
    .unwrap();
    let saved = &f.store.snapshot().unwrap().runs[0];
    assert_eq!(saved.status, "completed", "{:?}", saved.error);
    assert_eq!(saved.thread_id.as_deref(), Some("general-chat"));
}

#[derive(Default)]
struct LiveFormEvents(
    std::sync::Mutex<Vec<crate::agent::runtime_protocol::AgentRuntimeEventEnvelope>>,
);

impl NativeAgentTraceSink for LiveFormEvents {
    fn append_trace_event(
        &self,
        _session: &str,
        _turn: &str,
        event: &crate::agent::runtime_protocol::AgentRuntimeEventEnvelope,
    ) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct TwoFormsProvider(AtomicUsize);

impl BlockingTestProvider for TwoFormsProvider {
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        let call = self.0.fetch_add(1, Ordering::SeqCst);
        let tool_calls = if call < 2 {
            vec![NativeAgentToolCall {
                id: format!("form-{call}"), name: "request_user_input".into(),
                arguments_json: json!({"title":format!("Question {call}"), "fields":[{"name":"answer", "type":"text", "label":"Answer", "required":true}]}).to_string(),
                result: Value::Null,
            }]
        } else {
            let messages = context.messages.to_provider_messages().unwrap();
            assert_eq!(messages.iter().filter(|m| m["role"] == "tool").count(), 2);
            vec![]
        };
        Ok(NativeAgentProviderResponse {
            final_content: if tool_calls.is_empty() {
                "Both answers received".into()
            } else {
                String::new()
            },
            reasoning_delta: None,
            usage: None,
            response_items: vec![],
            tool_calls,
        })
    }
}

#[test]
fn regression_second_form_keeps_live_identity_after_durable_resume() {
    use crate::agent::bridge::{
        execute_thread_turn_with_services, submit_thread_form_with_services, SubmitThreadFormInput,
        SubmitThreadTurnInput,
    };
    let f = Fixture::new();
    let threads = f.threads();
    let thread = crate::rpc::call_rust_state_service(
        &threads,
        f.config(),
        crate::protocol::WorkerRequest::new(
            "create-forms-thread",
            "trace-forms",
            "thread.create",
            json!({"title":"Two questions"}),
        ),
        "Create form test thread",
    )
    .unwrap();
    let thread_id = thread["threadId"].as_str().unwrap().to_string();
    let events = Arc::new(LiveFormEvents::default());
    let services = NativeAgentRuntimeServices::new(
        Arc::new(TwoFormsProvider(AtomicUsize::new(0))),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    let first = tauri::async_runtime::block_on(execute_thread_turn_with_services(
        services.clone(),
        SubmitThreadTurnInput {
            thread_id: Some(thread_id.clone()),
            input: json!({"content":"Ask two questions"}),
            spec: json!({"runtime":"rust", "stream":true, "turnId":"two-forms"}),
        },
        f.root.clone(),
        f.config(),
        Some(events.clone()),
    ))
    .unwrap();
    assert_eq!(first.result.stop_reason, AgentStopReason::AwaitingForm);
    for index in 0..2 {
        let result = tauri::async_runtime::block_on(submit_thread_form_with_services(
            services.clone(),
            SubmitThreadFormInput {
                command_id: format!("submit-{index}"),
                thread_id: thread_id.clone(),
                form_id: format!("user-input:form-{index}"),
                source: json!({"control":"chat-form", "surface":"chat"}),
                target: json!({"threadId":thread_id, "turnId":"two-forms"}),
                values: json!({"answer":format!("Answer {index}")}),
                action: Some("submit".into()),
            },
            f.root.clone(),
            f.config(),
            Some(events.clone()),
        ))
        .unwrap();
        assert_eq!(result["formResult"]["statusCode"], 200);
        let recorded = events.0.lock().unwrap();
        let forms = recorded
            .iter()
            .filter(|e| e.event_name == "agent.awaiting_form")
            .collect::<Vec<_>>();
        assert_eq!(forms.len(), 2);
        for (ordinal, event) in forms.iter().enumerate() {
            assert_eq!(
                event
                    .trace_context
                    .as_ref()
                    .and_then(|t| t.thread_id.as_deref()),
                Some(thread_id.as_str()),
                "form {ordinal} must contain the thread identity required by the desktop renderer"
            );
        }
        assert!(forms[1].sequence > forms[0].sequence);
    }
    assert!(threads
        .latest_agent_checkpoint(&thread_id)
        .unwrap()
        .is_none());
}

#[test]
fn definitions_preserve_run_configuration_and_history_after_edit_delete_and_reopen() {
    let f = Fixture::new();
    let d = f.save();
    let mut run = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    assert!(execution::prepare(&f.store, &d.id, &f.config())
        .unwrap_err()
        .contains("active work"));
    run.status = "completed".into();
    f.store.update(&run).unwrap();
    let input = SaveDefinition {
        id: Some(d.id.clone()),
        expected_revision: Some(d.revision),
        name: "Updated".into(),
        instructions: "Different instructions".into(),
        workspace_path: d.workspace_path.clone(),
        execution: ExecutionOptions::default(),
        schedule: Default::default(),
    };
    let edited = f.store.save(input.clone()).unwrap();
    assert!(f.store.save(input).unwrap_err().contains("changed"));
    f.store.delete(&edited.id, edited.revision).unwrap();
    let reopened = Store::new(&f.root.join("data")).snapshot().unwrap();
    assert!(reopened.definitions.is_empty());
    assert_eq!(reopened.runs[0].definition, d);
    assert_eq!(reopened.runs[0].effective_model["model"], "test-model");
    assert!(
        !fs::read_to_string(f.root.join("data/automations/store.json"))
            .unwrap()
            .contains("secret-must-not-be-saved")
    );
}

#[test]
fn restart_marks_abandoned_work_interrupted_without_relaunching() {
    let f = Fixture::new();
    let d = f.save();
    let mut run = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    run.process_id = "previous-process".into();
    f.store.update(&run).unwrap();
    let snapshot = Store::new(&f.root.join("data")).snapshot().unwrap();
    assert_eq!(snapshot.runs.len(), 1);
    assert_eq!(snapshot.runs[0].status, "interrupted");
    assert_eq!(
        snapshot.runs[0].stop_reason.as_deref(),
        Some("runtime_restarted")
    );
    assert!(execution::prepare(&f.store, &d.id, &f.config()).is_ok());
}

#[test]
fn missing_workspace_and_unavailable_model_fail_before_creating_a_run() {
    let f = Fixture::new();
    let d = f.save();
    let mut config = f.config();
    config["agents"]["defaults"]["model"] = json!("unavailable");
    assert!(execution::prepare(&f.store, &d.id, &config)
        .unwrap_err()
        .contains("not available"));
    fs::remove_dir(&f.workspace).unwrap();
    assert!(execution::prepare(&f.store, &d.id, &f.config()).is_err());
    assert!(f.store.snapshot().unwrap().runs.is_empty());
}

struct ReportProvider {
    calls: AtomicUsize,
    workspace: PathBuf,
    fail: bool,
}
impl BlockingTestProvider for ReportProvider {
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        assert_eq!(
            fs::canonicalize(context.settings.working_directory.as_ref().unwrap()).unwrap(),
            fs::canonicalize(&self.workspace).unwrap()
        );
        if self.fail {
            return Err("observable test provider failure".into());
        }
        let tool_calls = if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            vec![NativeAgentToolCall { id: "write-report".into(), name: "apply_patch".into(), arguments_json: json!({
                "patch": "*** Begin Patch\n*** Add File: report.md\n+# Project report\n+Verified workspace output.\n*** End Patch\n"
            }).to_string(), result: Value::Null }]
        } else {
            vec![]
        };
        Ok(NativeAgentProviderResponse {
            final_content: if tool_calls.is_empty() {
                "[Project report](report.md)".into()
            } else {
                String::new()
            },
            reasoning_delta: None,
            usage: None,
            tool_calls,
            response_items: vec![],
        })
    }
}

#[test]
fn manual_execution_writes_report_in_selected_workspace_and_preserves_canonical_thread_link() {
    let f = Fixture::new();
    let d = f.save();
    let threads = f.threads();
    let run = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ReportProvider {
            calls: AtomicUsize::new(0),
            workspace: f.workspace.clone(),
            fail: false,
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        run.clone(),
        services.clone(),
        f.root.clone(),
        f.config(),
        None,
    ))
    .unwrap();
    let saved = &f.store.snapshot().unwrap().runs[0];
    assert_eq!(saved.status, "completed", "{:?}", saved.error);
    assert!(fs::read_to_string(f.workspace.join("report.md"))
        .unwrap()
        .contains("Verified workspace"));
    let thread = threads
        .read_agent_thread(saved.thread_id.as_ref().unwrap())
        .unwrap();
    assert_eq!(thread.thread.metadata.extra["automationRunId"], run.id);
    assert_eq!(
        execution::output(&f.store, &threads, &run.id).unwrap(),
        "[Project report](report.md)"
    );
    let next = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    assert_ne!(next.id, run.id);
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        next,
        services,
        f.root.clone(),
        f.config(),
        None,
    ))
    .unwrap();
    let history = Store::new(&f.root.join("data")).snapshot().unwrap();
    assert_eq!(history.runs.len(), 2);
    assert_eq!(history.runs[0].status, "completed");
    assert_ne!(history.runs[0].thread_id, history.runs[1].thread_id);
    // A waiting cache must follow the owning Turn after ordinary continuation.
    let mut stale = history.runs[0].clone();
    stale.status = "waiting".into();
    f.store.update(&stale).unwrap();
    assert_eq!(
        execution::snapshot(&f.store, &threads).unwrap().runs[0].status,
        "completed"
    );
}

#[test]
fn provider_failure_is_persisted_with_owning_thread_and_allows_next_run() {
    let f = Fixture::new();
    let d = f.save();
    let run = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ReportProvider {
            calls: AtomicUsize::new(0),
            workspace: f.workspace.clone(),
            fail: true,
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(f.threads());
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        run,
        services,
        f.root.clone(),
        f.config(),
        None,
    ))
    .unwrap();
    let saved = &f.store.snapshot().unwrap().runs[0];
    assert_eq!(saved.status, "failed");
    assert!(saved
        .error
        .as_ref()
        .unwrap()
        .contains("observable test provider failure"));
    assert!(saved.thread_id.is_some());
    assert!(execution::prepare(&f.store, &d.id, &f.config()).is_ok());
}

#[test]
fn schedule_claim_is_durable_and_preserves_active_ownership() {
    use super::schedule::{Repeat, Schedule};
    let f = Fixture::new();
    let d = f.save();
    let at = now();
    let input = SaveDefinition {
        id: Some(d.id),
        expected_revision: Some(1),
        name: d.name,
        instructions: d.instructions,
        workspace_path: d.workspace_path,
        execution: ExecutionOptions::default(),
        schedule: Schedule {
            repeat: Repeat::Daily,
            start_at_ms: Some(at),
        },
    };
    let d = f.store.save(input.clone()).unwrap();
    assert_eq!(f.store.claim_due(at, Some(at)).unwrap().len(), 1);
    assert!(f.store.claim_due(at, Some(at)).unwrap().is_empty());
    let next = f.store.snapshot().unwrap().definitions[0]
        .next_run_at_ms
        .unwrap();
    assert!(next > at);
    assert!(f.store.claim_due(next, Some(next)).unwrap().is_empty());
    let run = f.store.snapshot().unwrap().runs[0].clone();
    f.store
        .fail(&run.id, "Visible dispatch error".into())
        .unwrap();
    let reopened = Store::new(&f.root.join("data"));
    assert!(reopened.claim_due(at, Some(at)).unwrap().is_empty());
    let updated = reopened
        .save(SaveDefinition {
            expected_revision: Some(d.revision),
            name: "Renamed".into(),
            ..input
        })
        .unwrap();
    assert_eq!(updated.next_run_at_ms, Some(next));
    assert_eq!(reopened.claim_due(next, Some(next)).unwrap().len(), 1);
    assert_eq!(reopened.snapshot().unwrap().runs.len(), 2);
}

#[test]
fn once_schedule_does_not_rearm_on_edit_and_manual_disables_future_dispatch() {
    use super::schedule::{Repeat, Schedule};
    let f = Fixture::new();
    let d = f.save();
    let at = now();
    let input = SaveDefinition {
        id: Some(d.id),
        expected_revision: Some(d.revision),
        name: d.name,
        instructions: d.instructions,
        workspace_path: d.workspace_path,
        execution: ExecutionOptions::default(),
        schedule: Schedule {
            repeat: Repeat::Once,
            start_at_ms: Some(at + 60_000),
        },
    };
    let saved = f.store.save(input.clone()).unwrap();
    assert!(f.store.claim_due(at, Some(at)).unwrap().is_empty());
    let run = f
        .store
        .claim_due(at + 60_000, Some(at + 60_000))
        .unwrap()
        .remove(0);
    f.store.fail(&run.id, "No provider".into()).unwrap();
    let saved = f
        .store
        .save(SaveDefinition {
            expected_revision: Some(saved.revision),
            ..input.clone()
        })
        .unwrap();
    assert_eq!(saved.next_run_at_ms, None);
    assert!(f
        .store
        .claim_due(at + 120_000, Some(at + 120_000))
        .unwrap()
        .is_empty());
    let saved = f
        .store
        .save(SaveDefinition {
            expected_revision: Some(saved.revision),
            schedule: Schedule::default(),
            ..input
        })
        .unwrap();
    assert_eq!(saved.next_run_at_ms, None);
}

#[test]
fn recurrence_uses_local_clock_and_skips_weekends() {
    use super::schedule::{Repeat, Schedule};
    use chrono::{Local, TimeZone};
    let friday = Local
        .with_ymd_and_hms(2026, 9, 11, 8, 30, 0)
        .unwrap()
        .timestamp_millis() as u64;
    let monday = Local
        .with_ymd_and_hms(2026, 9, 14, 8, 30, 0)
        .unwrap()
        .timestamp_millis() as u64;
    let schedule = Schedule {
        repeat: Repeat::Weekdays,
        start_at_ms: Some(friday),
    };
    assert_eq!(schedule.after(friday).unwrap(), Some(monday));
    let weekly = Schedule {
        repeat: Repeat::Weekly,
        start_at_ms: Some(friday),
    };
    assert_eq!(
        weekly.after(monday).unwrap(),
        Some(
            Local
                .with_ymd_and_hms(2026, 9, 18, 8, 30, 0)
                .unwrap()
                .timestamp_millis() as u64
        )
    );
    assert!(Schedule {
        repeat: Repeat::Once,
        start_at_ms: None
    }
    .first()
    .is_err());
}

#[test]
fn missed_schedules_survive_restart_and_run_now_preserves_future_occurrences() {
    use super::schedule::{Repeat, Schedule};
    // Explicit clock inputs cover startup, sleep, and multiple missed weeks.
    let start = 1_800_000_000_000;
    let resumed = start + 22 * 86_400_000;
    for previous in [None, Some(start - 5_000)] {
        let f = Fixture::new();
        let d = f
            .store
            .save(SaveDefinition {
                schedule: Schedule {
                    repeat: Repeat::Weekly,
                    start_at_ms: Some(start),
                },
                id: None,
                expected_revision: None,
                name: "Weekly report".into(),
                instructions: "Write report.md".into(),
                workspace_path: f.workspace.to_string_lossy().into(),
                execution: Default::default(),
            })
            .unwrap();
        assert!(f.store.claim_due(resumed, previous).unwrap().is_empty());
        let reopened = Store::new(&f.root.join("data"));
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(
            snapshot.runs.len(),
            1,
            "coalesce the backlog into one missed entry"
        );
        let missed = snapshot.runs[0].clone();
        assert_eq!(missed.status, "missed");
        assert_eq!(missed.scheduled_at_ms, Some(start));
        assert_eq!(missed.finished_at_ms, Some(resumed));
        assert!(missed.thread_id.is_none());
        assert!(missed.effective_model.is_null());
        let next = snapshot.definitions[0].next_run_at_ms.unwrap();
        assert!(next > resumed);
        assert!(reopened
            .claim_due(resumed + 5_000, None)
            .unwrap()
            .is_empty());
        assert_eq!(reopened.snapshot().unwrap().runs.len(), 1);

        let run = execution::prepare(&reopened, &d.id, &f.config()).unwrap();
        assert_ne!(run.id, missed.id);
        assert_eq!(run.scheduled_at_ms, None);
        assert!(execution::prepare(&reopened, &d.id, &f.config()).is_err());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(ReportProvider {
                calls: AtomicUsize::new(0),
                workspace: f.workspace.clone(),
                fail: false,
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(f.threads());
        tauri::async_runtime::block_on(execution::execute(
            reopened.clone(),
            run.clone(),
            services,
            f.root.clone(),
            f.config(),
            None,
        ))
        .unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot.runs[0].status, "completed");
        assert!(snapshot.runs[0].thread_id.is_some());
        assert!(f.workspace.join("report.md").exists());
        assert_eq!(snapshot.runs[1], missed);
        assert_eq!(snapshot.definitions[0].next_run_at_ms, Some(next));
        assert_eq!(
            reopened
                .claim_due(next + 3_000, Some(next - 2_000))
                .unwrap()
                .len(),
            1
        );
        assert!(reopened
            .claim_due(next + 8_000, Some(next + 3_000))
            .unwrap()
            .is_empty());
    }
}

#[test]
fn sleep_skips_once_schedule_even_with_active_work_and_keeps_manual_non_overlap() {
    use super::schedule::{Repeat, Schedule};
    let f = Fixture::new();
    let start = 1_800_000_000_000;
    let d = f
        .store
        .save(SaveDefinition {
            id: None,
            expected_revision: None,
            name: "Once".into(),
            instructions: "Write report.md".into(),
            workspace_path: f.workspace.to_string_lossy().into(),
            execution: Default::default(),
            schedule: Schedule {
                repeat: Repeat::Once,
                start_at_ms: Some(start),
            },
        })
        .unwrap();
    let mut active = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    active.status = "waiting".into();
    f.store.update(&active).unwrap();
    assert!(f
        .store
        .claim_due(start + 20_000, Some(start - 5_000))
        .unwrap()
        .is_empty());
    let snapshot = f.store.snapshot().unwrap();
    assert_eq!(snapshot.runs[0].status, "missed");
    assert_eq!(snapshot.runs[1].status, "waiting");
    assert_eq!(snapshot.definitions[0].next_run_at_ms, None);
    assert!(execution::prepare(&f.store, &d.id, &f.config()).is_err());
    f.store
        .fail(&active.id, "Finished active work".into())
        .unwrap();
    assert!(f
        .store
        .claim_due(start + 25_000, Some(start + 20_000))
        .unwrap()
        .is_empty());
    assert!(execution::prepare(&f.store, &d.id, &f.config()).is_ok());
}

#[test]
fn ordinary_poll_delay_and_busy_occurrences_are_not_missed() {
    use super::schedule::{Repeat, Schedule};
    let f = Fixture::new();
    let start = 1_800_000_000_000;
    let d = f
        .store
        .save(SaveDefinition {
            id: None,
            expected_revision: None,
            name: "Once".into(),
            instructions: "Write report.md".into(),
            workspace_path: f.workspace.to_string_lossy().into(),
            execution: Default::default(),
            schedule: Schedule {
                repeat: Repeat::Once,
                start_at_ms: Some(start),
            },
        })
        .unwrap();
    let active = execution::prepare(&f.store, &d.id, &f.config()).unwrap();
    assert!(f
        .store
        .claim_due(start + 5_000, Some(start - 5_000))
        .unwrap()
        .is_empty());
    assert_eq!(f.store.snapshot().unwrap().runs.len(), 1);
    // A sleep after this occurrence was already blocked does not reclassify it.
    assert!(f
        .store
        .claim_due(start + 60_000, Some(start + 5_000))
        .unwrap()
        .is_empty());
    f.store
        .fail(&active.id, "Finished active work".into())
        .unwrap();
    let runs = f
        .store
        .claim_due(start + 65_000, Some(start + 60_000))
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].scheduled_at_ms, Some(start));
    assert_eq!(f.store.snapshot().unwrap().runs.len(), 2);
}

struct ConfiguredProvider {
    calls: AtomicUsize,
}
impl BlockingTestProvider for ConfiguredProvider {
    fn complete(&self, context: &AgentTurnContext) -> Result<NativeAgentProviderResponse, String> {
        assert_eq!(context.settings.model, "selected-model");
        assert_eq!(
            context
                .settings
                .reasoning
                .as_ref()
                .unwrap()
                .effort
                .as_deref(),
            Some("high")
        );
        let profile =
            crate::agent::provider::resolve_provider_profile(&context.config_snapshot, None, None)
                .unwrap();
        assert_eq!(
            profile.api_base.as_deref(),
            Some("https://selected.example/v1")
        );
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 2 {
            assert!(
                serde_json::to_string(&context.messages.to_legacy_messages().unwrap())
                    .unwrap()
                    .contains("Run output 1")
            );
        }
        Ok(NativeAgentProviderResponse {
            final_content: format!("Run output {call}"),
            reasoning_delta: None,
            usage: None,
            tool_calls: vec![],
            response_items: vec![],
        })
    }
}

#[test]
fn scheduled_execution_reuses_conversation_with_selected_profile_model_and_reasoning() {
    use super::schedule::{Repeat, Schedule};
    let f = Fixture::new();
    let mut config = f.config();
    config["providers"]["profiles"] = json!({"selected": {"provider":"openai", "apiBase":"https://selected.example/v1", "apiKey":"not-persisted", "models":["selected-model"], "enabledModels":["selected-model"]}});
    let options = ExecutionOptions {
        provider: Some("openai".into()),
        profile: Some("selected".into()),
        model: Some("selected-model".into()),
        reasoning_effort: Some("high".into()),
        ..Default::default()
    };
    let d = f
        .store
        .save(SaveDefinition {
            id: None,
            expected_revision: None,
            name: "Configured".into(),
            instructions: "Review project".into(),
            workspace_path: f.workspace.to_string_lossy().into(),
            execution: options.clone(),
            schedule: Default::default(),
        })
        .unwrap();
    let threads = f.threads();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(ConfiguredProvider {
            calls: AtomicUsize::new(0),
        }),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(threads.clone());
    let first = execution::prepare(&f.store, &d.id, &config).unwrap();
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        first.clone(),
        services.clone(),
        f.root.clone(),
        config.clone(),
        None,
    ))
    .unwrap();
    let first = f.store.snapshot().unwrap().runs[0].clone();
    assert_eq!(first.status, "completed", "{:?}", first.error);
    let at = now();
    let options = ExecutionOptions {
        thread_id: first.thread_id.clone(),
        ..options
    };
    assert!(
        execution::validate_thread(&options, &f.root.to_string_lossy(), &threads)
            .unwrap_err()
            .contains("different workspace")
    );
    f.store
        .save(SaveDefinition {
            id: Some(d.id),
            expected_revision: Some(d.revision),
            name: d.name,
            instructions: "Continue the review".into(),
            workspace_path: d.workspace_path,
            execution: options,
            schedule: Schedule {
                repeat: Repeat::Once,
                start_at_ms: Some(at),
            },
        })
        .unwrap();
    let mut next = f.store.claim_due(at, Some(at)).unwrap().remove(0);
    next.effective_model = execution::effective_model(
        &next.definition.execution,
        &next.definition.workspace_path,
        &config,
    )
    .unwrap();
    f.store.update(&next).unwrap();
    let id = next.id.clone();
    tauri::async_runtime::block_on(execution::execute(
        f.store.clone(),
        next,
        services,
        f.root.clone(),
        config,
        None,
    ))
    .unwrap();
    let latest = f.store.snapshot().unwrap().runs[0].clone();
    assert_eq!(latest.status, "completed", "{:?}", latest.error);
    assert_eq!(latest.thread_id, first.thread_id);
    assert_eq!(
        execution::output(&f.store, &threads, &first.id).unwrap(),
        "Run output 1"
    );
    assert_eq!(
        execution::output(&f.store, &threads, &id).unwrap(),
        "Run output 2"
    );
}

#[test]
fn explicit_disabled_provider_or_model_is_rejected() {
    let f = Fixture::new();
    let mut config = f.config();
    let options = ExecutionOptions {
        provider: Some("openai".into()),
        model: Some("test-model".into()),
        ..Default::default()
    };
    config["providers"]["openai"]["enabled"] = json!(false);
    assert!(
        execution::effective_model(&options, &f.workspace.to_string_lossy(), &config)
            .unwrap_err()
            .contains("disabled")
    );
    config["providers"]["openai"]["enabled"] = json!(true);
    config["providers"]["openai"]["enabledModels"] = json!([]);
    assert!(
        execution::effective_model(&options, &f.workspace.to_string_lossy(), &config)
            .unwrap_err()
            .contains("disabled")
    );
}
