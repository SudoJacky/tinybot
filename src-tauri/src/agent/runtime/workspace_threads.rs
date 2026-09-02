use super::{AgentTurnContext, NativeAgentRuntimeServices};
use crate::agent::bridge::{
    execute_thread_turn_with_services, native_agent_string_field, native_agent_turn_status,
    SubmitThreadTurnInput,
};
use crate::project_groups::ProjectGroup;
#[cfg(test)]
use crate::project_groups::SaveProjectGroupInput;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use crate::tools::registry::{WorkspaceThreadTarget, WorkspaceThreadToolContributor};
use crate::workspace_registry::{canonical_workspace, workspace_id};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const WORKSPACE_THREAD_SOURCE: &str = "workspace_thread";
static WORKSPACE_THREAD_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnWorkspaceThreadArgs {
    workspace_id: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendThreadMessageArgs {
    thread_id: String,
    message: String,
}

pub(super) fn tool_contributor(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
) -> Result<Option<WorkspaceThreadToolContributor>, String> {
    let Some(thread_store) = services.optional_thread_store() else {
        return Ok(None);
    };
    let Some(project_group) =
        coordinator_project_group(&thread_store, context.config_snapshot.clone(), context)?
    else {
        return Ok(None);
    };
    let targets = available_project_workspaces(&project_group);
    if targets.is_empty() {
        return Ok(None);
    }
    WorkspaceThreadToolContributor::new(targets).map(Some)
}

pub(super) async fn spawn_workspace_thread(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    arguments: &serde_json::Map<String, Value>,
) -> Result<Value, String> {
    let args = parse_spawn_args(arguments)?;
    let parent_thread_id = current_thread_id(context)?;
    let thread_store = services.thread_store()?;
    let project_group =
        coordinator_project_group(&thread_store, context.config_snapshot.clone(), context)?
            .ok_or_else(|| {
                "spawn_workspace_thread requires a project coordinator thread".to_string()
            })?;
    let target_workspace = thread_store
        .project_groups()
        .authorize_workspace(&project_group.project_group_id, &args.workspace_id)?;
    let target_workspace_id = workspace_id(&target_workspace);
    let thread_id = generate_workspace_thread_id();
    let title = message_title(&args.message);
    let request_id = next_worker_request_correlation();
    let created = call_rust_state_service(
        &thread_store,
        context.config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("workspace-thread-create"),
            request_id.trace_id("workspace-thread-create"),
            "thread.create",
            json!({
                "threadId": thread_id,
                "title": title,
                "parentThreadId": parent_thread_id,
                "source": WORKSPACE_THREAD_SOURCE,
                "metadata": {
                    "workingDirectory": target_workspace_id,
                    "model": context.model,
                    "extra": {
                        "modelProvider": context.provider,
                        "projectGroupId": project_group.project_group_id,
                        "workspaceThreadParentId": parent_thread_id,
                    }
                }
            }),
        ),
        "workspace thread create",
    )?;
    let created_thread_id = created
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "workspace thread create returned no threadId".to_string())?;
    if created_thread_id != thread_id {
        return Err("workspace thread create returned an unexpected threadId".to_string());
    }
    eprintln!(
        "workspace_thread_created {}",
        json!({
            "parentThreadId": parent_thread_id,
            "projectGroupId": project_group.project_group_id,
            "threadId": thread_id,
            "workspaceId": target_workspace_id,
        })
    );
    run_workspace_thread_turn(services, context, &thread_id, &args.message).await
}

pub(super) async fn send_thread_message(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    arguments: &serde_json::Map<String, Value>,
) -> Result<Value, String> {
    let args = parse_send_args(arguments)?;
    let parent_thread_id = current_thread_id(context)?;
    let thread_store = services.thread_store()?;
    let project_group =
        coordinator_project_group(&thread_store, context.config_snapshot.clone(), context)?
            .ok_or_else(|| {
                "send_thread_message requires a project coordinator thread".to_string()
            })?;
    let thread = read_thread(
        &thread_store,
        context.config_snapshot.clone(),
        &args.thread_id,
        "workspace thread message target read",
    )?;
    if thread.get("parentThreadId").and_then(Value::as_str) != Some(parent_thread_id.as_str())
        || thread.get("source").and_then(Value::as_str) != Some(WORKSPACE_THREAD_SOURCE)
    {
        return Err(format!(
            "thread `{}` was not created by current thread `{parent_thread_id}`",
            args.thread_id
        ));
    }
    if thread_project_group_id(&thread).as_deref() != Some(project_group.project_group_id.as_str())
    {
        return Err(format!(
            "thread `{}` does not belong to project group `{}`",
            args.thread_id, project_group.project_group_id
        ));
    }
    let target_workspace = thread_workspace(&thread)?;
    thread_store.project_groups().authorize_workspace(
        &project_group.project_group_id,
        &workspace_id(&target_workspace),
    )?;
    eprintln!(
        "workspace_thread_message_sent {}",
        json!({
            "parentThreadId": parent_thread_id,
            "projectGroupId": project_group.project_group_id,
            "threadId": args.thread_id,
        })
    );
    run_workspace_thread_turn(services, context, &args.thread_id, &args.message).await
}

fn run_workspace_thread_turn(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    thread_id: &str,
    message: &str,
) -> BoxFuture<'static, Result<Value, String>> {
    let services = services.clone();
    let context = context.clone();
    let thread_id = thread_id.to_string();
    let message = message.to_string();
    Box::pin(async move {
        let parent_thread_id = current_thread_id(&context)?;
        let child_turn_id = generate_workspace_turn_id();
        let mut spec = json!({
            "runtime": "rust",
            "turnId": child_turn_id,
            "model": context.model,
            "messages": [{ "role": "user", "content": &message }],
            "metadata": {
                "parentThreadId": parent_thread_id,
                "parentTurnId": context.turn_id,
            }
        });
        if let Some(provider) = context.provider.as_ref() {
            spec["provider"] = Value::String(provider.clone());
        }
        let execution = execute_thread_turn_with_services(
            services.clone(),
            SubmitThreadTurnInput {
                thread_id: Some(thread_id.clone()),
                input: json!({ "content": &message }),
                spec,
            },
            PathBuf::from(thread_id_workspace(&services, &context, &thread_id)?),
            context.config_snapshot.clone(),
            None,
        );
        tokio::pin!(execution);
        let executed = if let Some(parent_cancellation) = context.cancellation.clone() {
            tokio::select! {
                biased;
                result = &mut execution => result?,
                _ = parent_cancellation.cancelled() => {
                    eprintln!(
                        "workspace_thread_turn_cancel_requested {}",
                        json!({
                            "parentThreadId": parent_thread_id,
                            "parentTurnId": context.turn_id,
                            "threadId": thread_id,
                            "turnId": child_turn_id,
                        })
                    );
                    services.cancel(&child_turn_id);
                    (&mut execution).await?
                }
            }
        } else {
            execution.await?
        };
        let stop_reason = executed
            .result
            .get("stopReason")
            .or_else(|| executed.result.get("stop_reason"))
            .and_then(Value::as_str);
        let status = workspace_thread_status(stop_reason);
        let final_message = executed
            .result
            .get("finalContent")
            .or_else(|| executed.result.get("final_content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        eprintln!(
            "workspace_thread_turn_stopped {}",
            json!({
                "parentThreadId": parent_thread_id,
                "parentTurnId": context.turn_id,
                "threadId": executed.thread_id,
                "turnId": executed.turn_id,
                "stopReason": stop_reason,
                "status": status,
            })
        );
        Ok(json!({
            "threadId": executed.thread_id,
            "status": status,
            "finalMessage": final_message,
        }))
    })
}

fn coordinator_project_group(
    thread_store: &WorkspaceThreadStore,
    config_snapshot: Value,
    context: &AgentTurnContext,
) -> Result<Option<ProjectGroup>, String> {
    let Some(thread_id) = context
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let thread = read_thread(
        thread_store,
        config_snapshot,
        thread_id,
        "project coordinator thread read",
    )?;
    if thread.get("source").and_then(Value::as_str) != Some("project_coordinator") {
        return Ok(None);
    }
    let Some(project_group_id) = thread_project_group_id(&thread) else {
        return Err(format!(
            "project coordinator thread `{thread_id}` has no projectGroupId"
        ));
    };
    let project_group = thread_store
        .project_groups()
        .find_group(&project_group_id)?;
    if project_group.is_none() {
        eprintln!(
            "project_coordinator_group_missing thread_id={} project_group_id={}",
            thread_id, project_group_id
        );
    }
    Ok(project_group)
}

fn available_project_workspaces(project_group: &ProjectGroup) -> Vec<WorkspaceThreadTarget> {
    project_group
        .workspace_ids
        .iter()
        .filter_map(|workspace_id_value| {
            let workspace = match canonical_workspace(Path::new(workspace_id_value)) {
                Ok(workspace) => workspace,
                Err(error) => {
                    eprintln!(
                        "project_group_workspace_unavailable project_group_id={} workspace_id={} error={}",
                        project_group.project_group_id, workspace_id_value, error
                    );
                    return None;
                }
            };
            let public_id = workspace_id(&workspace);
            let label = workspace
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(public_id.as_str())
                .to_string();
            Some(WorkspaceThreadTarget {
                workspace_id: public_id,
                label,
            })
        })
        .collect()
}

fn current_thread_id(context: &AgentTurnContext) -> Result<String, String> {
    context
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "workspace thread tools require a persisted parent thread".to_string())
}

fn thread_id_workspace(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    thread_id: &str,
) -> Result<String, String> {
    let thread = read_thread(
        &services.thread_store()?,
        context.config_snapshot.clone(),
        thread_id,
        "workspace thread execution target read",
    )?;
    Ok(thread_workspace(&thread)?.display().to_string())
}

fn read_thread(
    thread_store: &WorkspaceThreadStore,
    config_snapshot: Value,
    thread_id: &str,
    label: &str,
) -> Result<Value, String> {
    let request_id = next_worker_request_correlation();
    let snapshot = call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("workspace-thread-read"),
            request_id.trace_id("workspace-thread-read"),
            "thread.read",
            json!({ "threadId": thread_id }),
        ),
        label,
    )?;
    snapshot
        .get("thread")
        .cloned()
        .ok_or_else(|| format!("{label} returned no thread"))
}

fn thread_workspace(thread: &Value) -> Result<PathBuf, String> {
    let working_directory = thread
        .get("metadata")
        .and_then(|metadata| native_agent_string_field(metadata, "workingDirectory"))
        .ok_or_else(|| "workspace thread has no workingDirectory".to_string())?;
    canonical_workspace(Path::new(&working_directory))
}

fn thread_project_group_id(thread: &Value) -> Option<String> {
    thread
        .get("metadata")
        .and_then(|metadata| metadata.get("extra"))
        .and_then(|extra| native_agent_string_field(extra, "projectGroupId"))
}

fn parse_spawn_args(
    arguments: &serde_json::Map<String, Value>,
) -> Result<SpawnWorkspaceThreadArgs, String> {
    let mut args =
        serde_json::from_value::<SpawnWorkspaceThreadArgs>(Value::Object(arguments.clone()))
            .map_err(|error| format!("invalid spawn_workspace_thread arguments: {error}"))?;
    args.workspace_id = non_empty_argument("workspaceId", args.workspace_id)?;
    args.message = non_empty_argument("message", args.message)?;
    Ok(args)
}

fn parse_send_args(
    arguments: &serde_json::Map<String, Value>,
) -> Result<SendThreadMessageArgs, String> {
    let mut args =
        serde_json::from_value::<SendThreadMessageArgs>(Value::Object(arguments.clone()))
            .map_err(|error| format!("invalid send_thread_message arguments: {error}"))?;
    args.thread_id = non_empty_argument("threadId", args.thread_id)?;
    args.message = non_empty_argument("message", args.message)?;
    Ok(args)
}

fn non_empty_argument(name: &str, value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    Ok(value)
}

fn workspace_thread_status(stop_reason: Option<&str>) -> &'static str {
    match native_agent_turn_status(stop_reason) {
        "completed" => "completed",
        "waiting" => "awaiting_user",
        "interrupted" | "cancelled" => "interrupted",
        _ => "failed",
    }
}

fn message_title(message: &str) -> String {
    let title = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = title.chars();
    let shortened = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    }
}

fn generate_workspace_thread_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = WORKSPACE_THREAD_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("thread-workspace-{now}-{sequence}")
}

fn generate_workspace_turn_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = WORKSPACE_THREAD_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("turn-workspace-{now}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runtime::{
        run_native_agent_turn_with_workspace_async, FakeNativeAgentToolDispatcher,
        InMemoryNativeAgentCancellation, InMemoryNativeAgentCheckpointStore, NativeAgentProvider,
        NativeAgentProviderFailure, NativeAgentProviderResponse, NativeAgentProviderStreamEvent,
        NativeAgentToolCall, NativeAgentTraceSink,
    };
    use crate::agent::runtime_protocol::{AgentRuntimeEventEnvelope, AgentTimelinePatch};
    use crate::protocol::capability::default_desktop_capability_policy;
    use crate::tools::registry::SPAWN_WORKSPACE_THREAD_METHOD;
    use std::sync::{Arc, Mutex};

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(generate_workspace_thread_id());
            std::fs::create_dir_all(root.join("service-a"))
                .expect("test child workspace should create");
            Self { root }
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct SessionRecordingTraceSink {
        timeline_patch_session_ids: Mutex<Vec<String>>,
    }

    impl NativeAgentTraceSink for SessionRecordingTraceSink {
        fn append_trace_event(
            &self,
            _session_id: &str,
            _turn_id: &str,
            _event: &AgentRuntimeEventEnvelope,
        ) -> Result<(), String> {
            Ok(())
        }

        fn append_timeline_patch(
            &self,
            session_id: &str,
            _turn_id: &str,
            _patch: &AgentTimelinePatch,
        ) -> Result<(), String> {
            self.timeline_patch_session_ids
                .lock()
                .expect("timeline patch session lock should not be poisoned")
                .push(session_id.to_string());
            Ok(())
        }
    }

    struct ChildTurnProvider {
        calls: AtomicU64,
    }

    impl NativeAgentProvider for ChildTurnProvider {
        fn complete(
            &self,
            _context: &AgentTurnContext,
        ) -> Result<NativeAgentProviderResponse, String> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(NativeAgentProviderResponse {
                final_content: if call == 0 {
                    "initial child result".to_string()
                } else {
                    "follow-up child result".to_string()
                },
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
                response_items: Vec::new(),
            })
        }
    }

    fn create_thread(
        store: &WorkspaceThreadStore,
        root: Option<&Path>,
        thread_id: &str,
        parent_thread_id: Option<&str>,
        source: &str,
        project_group_id: Option<&str>,
    ) {
        let mut metadata = json!({});
        if let Some(root) = root {
            metadata["workingDirectory"] = Value::String(root.display().to_string());
        }
        if let Some(project_group_id) = project_group_id {
            metadata["extra"] = json!({ "projectGroupId": project_group_id });
        }
        let request_id = next_worker_request_correlation();
        call_rust_state_service(
            store,
            json!({}),
            WorkerRequest::new(
                request_id.id("workspace-thread-test-create"),
                request_id.trace_id("workspace-thread-test-create"),
                "thread.create",
                json!({
                    "threadId": thread_id,
                    "parentThreadId": parent_thread_id,
                    "source": source,
                    "metadata": metadata,
                }),
            ),
            "workspace thread test create",
        )
        .expect("test thread should create");
    }

    #[test]
    fn result_status_has_only_the_public_workspace_thread_states() {
        assert_eq!(workspace_thread_status(Some("final_response")), "completed");
        assert_eq!(
            workspace_thread_status(Some("awaiting_form")),
            "awaiting_user"
        );
        assert_eq!(workspace_thread_status(Some("cancelled")), "interrupted");
        assert_eq!(workspace_thread_status(Some("provider_error")), "failed");
    }

    #[test]
    fn coordinator_waits_for_every_spawn_in_a_parallel_tool_batch() {
        struct ParallelSpawnProvider {
            parent_calls: AtomicU64,
            workspace_ids: Vec<String>,
        }

        impl NativeAgentProvider for ParallelSpawnProvider {
            fn complete(
                &self,
                context: &AgentTurnContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                if context.thread_id.as_deref() != Some("parallel-parent-thread") {
                    return Ok(NativeAgentProviderResponse {
                        final_content: format!(
                            "child result from {}",
                            context.thread_id.as_ref().cloned().unwrap_or_default()
                        ),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: Vec::new(),
                        response_items: Vec::new(),
                    });
                }

                if self.parent_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Ok(NativeAgentProviderResponse {
                        final_content: String::new(),
                        reasoning_delta: None,
                        usage: None,
                        tool_calls: self
                            .workspace_ids
                            .iter()
                            .take(2)
                            .enumerate()
                            .map(|(index, workspace_id)| NativeAgentToolCall {
                                id: format!("call-spawn-{index}"),
                                name: SPAWN_WORKSPACE_THREAD_METHOD.to_string(),
                                arguments_json: json!({
                                    "workspaceId": workspace_id,
                                    "message": format!("Inspect workspace {index}"),
                                })
                                .to_string(),
                                result: json!({}),
                            })
                            .collect(),
                        response_items: Vec::new(),
                    });
                }

                Ok(NativeAgentProviderResponse {
                    final_content: "all workspace threads completed".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_calls: Vec::new(),
                    response_items: Vec::new(),
                })
            }
        }

        let workspace = TestWorkspace::new();
        let service_a = workspace.root.join("service-a");
        let service_b = workspace.root.join("service-b");
        std::fs::create_dir_all(&service_b).expect("second child workspace should create");
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        );
        let project_group = store
            .project_groups()
            .save(SaveProjectGroupInput {
                project_group_id: None,
                name: "Parallel services".to_string(),
                workspace_ids: vec![
                    service_a.display().to_string(),
                    service_b.display().to_string(),
                ],
            })
            .expect("project group should save");
        create_thread(
            &store,
            None,
            "parallel-parent-thread",
            None,
            "project_coordinator",
            Some(&project_group.project_group_id),
        );
        let trace_sink = Arc::new(SessionRecordingTraceSink::default());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(ParallelSpawnProvider {
                parent_calls: AtomicU64::new(0),
                workspace_ids: vec![
                    workspace_id(&service_a.canonicalize().unwrap()),
                    workspace_id(&service_b.canonicalize().unwrap()),
                ],
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_trace_sink(trace_sink.clone())
        .with_thread_store(store);

        let result = tauri::async_runtime::block_on(run_native_agent_turn_with_workspace_async(
            &services,
            json!({
                "runtime": "rust",
                "threadId": "parallel-parent-thread",
                "sessionId": "parallel-parent-thread",
                "turnId": "parallel-parent-turn",
                "model": "fixture-model",
                "maxIterations": 3,
                "messages": [{ "role": "user", "content": "inspect both workspaces" }],
            }),
            json!({}),
            &workspace.root,
        ))
        .expect("parallel workspace spawns should complete");

        assert_eq!(result["stopReason"], "final_response");
        assert_eq!(result["finalContent"], "all workspace threads completed");
        let completed = result["completedToolResults"]
            .as_array()
            .expect("completed tool results should be an array");
        assert_eq!(completed.len(), 2);
        assert_eq!(completed[0]["toolCallId"], "call-spawn-0");
        assert_eq!(completed[1]["toolCallId"], "call-spawn-1");
        let child_patch_session_ids = trace_sink
            .timeline_patch_session_ids
            .lock()
            .expect("timeline patch session lock should not be poisoned")
            .iter()
            .filter(|session_id| session_id.as_str() != "parallel-parent-thread")
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            child_patch_session_ids.len(),
            2,
            "each spawned workspace Thread must publish live timeline patches"
        );
    }

    #[test]
    fn cancelling_coordinator_interrupts_the_active_workspace_turn() {
        struct PendingWorkspaceTurnProvider {
            parent_calls: AtomicU64,
            workspace_id: String,
            child_started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        }

        impl NativeAgentProvider for PendingWorkspaceTurnProvider {
            fn complete(
                &self,
                _context: &AgentTurnContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                panic!("workspace cancellation test must use async provider dispatch");
            }

            fn complete_streaming_async<'a>(
                self: Arc<Self>,
                context: &'a AgentTurnContext,
                _observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<
                                NativeAgentProviderResponse,
                                NativeAgentProviderFailure,
                            >,
                        > + Send
                        + 'a,
                >,
            > {
                if context.thread_id.as_deref() == Some("cancelling-parent-thread") {
                    let call = self.parent_calls.fetch_add(1, Ordering::SeqCst);
                    let workspace_id = self.workspace_id.clone();
                    return Box::pin(async move {
                        Ok(NativeAgentProviderResponse {
                            final_content: if call == 0 {
                                String::new()
                            } else {
                                "parent should not continue after cancellation".to_string()
                            },
                            reasoning_delta: None,
                            usage: None,
                            tool_calls: if call == 0 {
                                vec![NativeAgentToolCall {
                                    id: "call-cancel-workspace-turn".to_string(),
                                    name: SPAWN_WORKSPACE_THREAD_METHOD.to_string(),
                                    arguments_json: json!({
                                        "workspaceId": workspace_id,
                                        "message": "Wait for parent cancellation",
                                    })
                                    .to_string(),
                                    result: json!({}),
                                }]
                            } else {
                                Vec::new()
                            },
                            response_items: Vec::new(),
                        })
                    });
                }

                let child_started = self
                    .child_started
                    .lock()
                    .expect("child provider start lock should not be poisoned")
                    .take();
                Box::pin(async move {
                    if let Some(child_started) = child_started {
                        child_started
                            .send(())
                            .expect("child provider start signal should send");
                    }
                    std::future::pending::<
                        Result<NativeAgentProviderResponse, NativeAgentProviderFailure>,
                    >()
                    .await
                })
            }
        }

        tauri::async_runtime::block_on(async {
            let workspace = TestWorkspace::new();
            let child_workspace = workspace.root.join("service-a");
            let store = WorkspaceThreadStore::new_with_data_root(
                workspace.root.clone(),
                workspace.root.join("thread-data"),
                default_desktop_capability_policy(),
            );
            let project_group = store
                .project_groups()
                .save(SaveProjectGroupInput {
                    project_group_id: None,
                    name: "Cancellation services".to_string(),
                    workspace_ids: vec![child_workspace.display().to_string()],
                })
                .expect("project group should save");
            create_thread(
                &store,
                None,
                "cancelling-parent-thread",
                None,
                "project_coordinator",
                Some(&project_group.project_group_id),
            );
            let (child_started_sender, child_started_receiver) = tokio::sync::oneshot::channel();
            let services = NativeAgentRuntimeServices::new(
                Arc::new(PendingWorkspaceTurnProvider {
                    parent_calls: AtomicU64::new(0),
                    workspace_id: workspace_id(&child_workspace.canonicalize().unwrap()),
                    child_started: Mutex::new(Some(child_started_sender)),
                }),
                Arc::new(FakeNativeAgentToolDispatcher),
                Arc::new(InMemoryNativeAgentCheckpointStore::default()),
                Arc::new(InMemoryNativeAgentCancellation::default()),
            )
            .with_thread_store(store.clone());
            let run_services = services.clone();
            let workspace_root = workspace.root.clone();
            let run_task = tauri::async_runtime::spawn(async move {
                run_native_agent_turn_with_workspace_async(
                    &run_services,
                    json!({
                        "runtime": "rust",
                        "threadId": "cancelling-parent-thread",
                        "sessionId": "cancelling-parent-thread",
                        "turnId": "cancelling-parent-turn",
                        "model": "fixture-model",
                        "maxIterations": 3,
                        "messages": [{ "role": "user", "content": "delegate then stop" }],
                    }),
                    json!({}),
                    &workspace_root,
                )
                .await
            });

            tokio::time::timeout(std::time::Duration::from_secs(2), child_started_receiver)
                .await
                .expect("child provider should start before timeout")
                .expect("child provider start signal should arrive");
            services.cancel("cancelling-parent-turn");
            let result = tokio::time::timeout(std::time::Duration::from_secs(4), run_task)
                .await
                .expect("cancelled coordinator should stop before timeout")
                .expect("cancelled coordinator task should join")
                .expect("cancelled coordinator should return a structured result");

            assert_eq!(result["stopReason"], "interrupted");
            let request_id = next_worker_request_correlation();
            let listed = call_rust_state_service(
                &store,
                json!({}),
                WorkerRequest::new(
                    request_id.id("workspace-thread-cancellation-list"),
                    request_id.trace_id("workspace-thread-cancellation-list"),
                    "thread.list",
                    json!({ "includeArchived": true, "includeChildThreads": true }),
                ),
                "workspace thread cancellation list",
            )
            .expect("workspace thread list should load");
            let child_thread_id = listed["threads"]
                .as_array()
                .expect("workspace thread list should be an array")
                .iter()
                .find(|thread| thread["source"] == WORKSPACE_THREAD_SOURCE)
                .and_then(|thread| thread["threadId"].as_str())
                .expect("spawned workspace thread should exist");
            let request_id = next_worker_request_correlation();
            let child = call_rust_state_service(
                &store,
                json!({}),
                WorkerRequest::new(
                    request_id.id("workspace-thread-cancellation-read"),
                    request_id.trace_id("workspace-thread-cancellation-read"),
                    "thread.read",
                    json!({ "threadId": child_thread_id }),
                ),
                "cancelled workspace thread read",
            )
            .expect("cancelled workspace thread should load");
            assert_eq!(child["activeTurn"], Value::Null);
            assert_eq!(child["thread"]["status"], "idle");
            assert!(child["items"]
                .as_array()
                .expect("cancelled workspace thread items should be an array")
                .iter()
                .any(|item| item["kind"]["type"] == "cancelled"
                    && item["kind"]["payload"]["stopReason"] == "interrupted"));
        });
    }

    #[test]
    fn spawn_and_send_use_a_persisted_user_visible_child_thread() {
        let workspace = TestWorkspace::new();
        let child_workspace = workspace.root.join("service-a");
        let store = WorkspaceThreadStore::new_with_data_root(
            workspace.root.clone(),
            workspace.root.join("thread-data"),
            default_desktop_capability_policy(),
        );
        let project_group = store
            .project_groups()
            .save(SaveProjectGroupInput {
                project_group_id: None,
                name: "Commerce".to_string(),
                workspace_ids: vec![child_workspace.display().to_string()],
            })
            .unwrap();
        create_thread(
            &store,
            Some(&workspace.root),
            "ordinary-thread",
            None,
            "desktop",
            None,
        );
        create_thread(
            &store,
            None,
            "parent-thread",
            None,
            "project_coordinator",
            Some(&project_group.project_group_id),
        );
        let services = NativeAgentRuntimeServices::new(
            Arc::new(ChildTurnProvider {
                calls: AtomicU64::new(0),
            }),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
        .with_thread_store(store.clone());
        let ordinary_context = AgentTurnContext::from_spec(
            json!({
                "threadId": "ordinary-thread",
                "sessionId": "ordinary-thread",
                "turnId": "ordinary-turn",
                "cwd": workspace.root,
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "work locally" }],
            }),
            json!({}),
        );
        assert!(
            tool_contributor(&services, &ordinary_context)
                .expect("ordinary thread lookup should succeed")
                .is_none(),
            "ordinary workspace threads must not receive project coordination tools"
        );
        let context = AgentTurnContext::from_spec(
            json!({
                "threadId": "parent-thread",
                "sessionId": "parent-thread",
                "turnId": "parent-turn",
                "model": "fixture-model",
                "messages": [{ "role": "user", "content": "delegate" }],
            }),
            json!({}),
        );
        assert!(
            tool_contributor(&services, &context)
                .expect("project group lookup should succeed")
                .is_some(),
            "project coordinator should receive tools for explicit members"
        );
        create_thread(
            &store,
            Some(&child_workspace),
            "child-workspace-seed",
            None,
            "desktop",
            None,
        );
        let unrelated = tauri::async_runtime::block_on(send_thread_message(
            &services,
            &context,
            json!({
                "threadId": "child-workspace-seed",
                "message": "Do not accept this",
            })
            .as_object()
            .unwrap(),
        ))
        .expect_err("an unrelated child-workspace session must be rejected");
        assert!(unrelated.contains("was not created by current thread"));

        let spawned = tauri::async_runtime::block_on(spawn_workspace_thread(
            &services,
            &context,
            json!({
                "workspaceId": workspace_id(&child_workspace.canonicalize().unwrap()),
                "message": "Implement service endpoint",
            })
            .as_object()
            .unwrap(),
        ))
        .expect("workspace thread should spawn and complete");
        let spawned_thread_id = spawned["threadId"].as_str().unwrap().to_string();
        assert_eq!(spawned["status"], "completed");
        assert_eq!(spawned["finalMessage"], "initial child result");
        assert!(spawned.get("finalMessageId").is_none());

        let spawned_thread = read_thread(
            &store,
            json!({}),
            &spawned_thread_id,
            "spawned workspace thread test read",
        )
        .expect("spawned thread should persist");
        assert_eq!(spawned_thread["parentThreadId"], "parent-thread");
        assert_eq!(spawned_thread["source"], WORKSPACE_THREAD_SOURCE);
        assert_eq!(
            spawned_thread["metadata"]["extra"]["projectGroupId"],
            project_group.project_group_id
        );
        assert_eq!(
            spawned_thread["metadata"]["workingDirectory"],
            workspace_id(&child_workspace.canonicalize().unwrap())
        );

        let follow_up = tauri::async_runtime::block_on(send_thread_message(
            &services,
            &context,
            json!({
                "threadId": spawned_thread_id,
                "message": "Now add tests",
            })
            .as_object()
            .unwrap(),
        ))
        .expect("workspace thread should accept a follow-up message");
        assert_eq!(follow_up["status"], "completed");
        assert_eq!(follow_up["finalMessage"], "follow-up child result");
        assert!(follow_up.get("finalMessageId").is_none());

        let request_id = next_worker_request_correlation();
        let snapshot = call_rust_state_service(
            &store,
            json!({}),
            WorkerRequest::new(
                request_id.id("workspace-thread-test-read-messages"),
                request_id.trace_id("workspace-thread-test-read-messages"),
                "thread.read",
                json!({ "threadId": spawned_thread_id }),
            ),
            "workspace thread message snapshot",
        )
        .expect("workspace thread messages should persist");
        let user_messages = snapshot["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"]["type"] == "user_message")
            .map(|item| item["kind"]["payload"]["content"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            user_messages,
            vec![json!("Implement service endpoint"), json!("Now add tests")],
            "parent-agent messages must persist as ordinary user messages"
        );

        store
            .project_groups()
            .delete(&project_group.project_group_id)
            .expect("project group should delete");
        assert!(
            tool_contributor(&services, &context)
                .expect("deleted project group lookup should succeed")
                .is_none(),
            "a retained coordinator thread must lose cross-workspace tools after its group is deleted"
        );
    }
}
