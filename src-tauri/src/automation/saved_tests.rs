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
fn schedule_claim_is_durable_coalesces_missed_runs_and_preserves_active_ownership() {
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
            start_at_ms: Some(at - 3 * 86_400_000),
        },
    };
    let d = f.store.save(input.clone()).unwrap();
    assert_eq!(f.store.claim_due(at).unwrap().len(), 1);
    assert!(f.store.claim_due(at).unwrap().is_empty());
    let next = f.store.snapshot().unwrap().definitions[0]
        .next_run_at_ms
        .unwrap();
    assert!(next > at);
    assert!(f.store.claim_due(next).unwrap().is_empty());
    let run = f.store.snapshot().unwrap().runs[0].clone();
    f.store
        .fail(&run.id, "Visible dispatch error".into())
        .unwrap();
    let reopened = Store::new(&f.root.join("data"));
    assert!(reopened.claim_due(at).unwrap().is_empty());
    let updated = reopened
        .save(SaveDefinition {
            expected_revision: Some(d.revision),
            name: "Renamed".into(),
            ..input
        })
        .unwrap();
    assert_eq!(updated.next_run_at_ms, Some(next));
    assert_eq!(reopened.claim_due(next).unwrap().len(), 1);
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
    assert!(f.store.claim_due(at).unwrap().is_empty());
    let run = f.store.claim_due(at + 60_000).unwrap().remove(0);
    f.store.fail(&run.id, "No provider".into()).unwrap();
    let saved = f
        .store
        .save(SaveDefinition {
            expected_revision: Some(saved.revision),
            ..input.clone()
        })
        .unwrap();
    assert_eq!(saved.next_run_at_ms, None);
    assert!(f.store.claim_due(at + 120_000).unwrap().is_empty());
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
    let mut next = f.store.claim_due(at).unwrap().remove(0);
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
