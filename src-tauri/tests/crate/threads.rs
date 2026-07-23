use super::support::*;
use crate::agent::bridge::persist_native_agent_turn_start;
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::agent::runtime::NativeAgentTraceSink;
use crate::desktop::state::lock_runtime;
use crate::desktop::state::GatewayRuntime;
use crate::desktop_commands::agent::worker_restore_agent_checkpoint_with_options;
use crate::desktop_commands::agent::worker_run_agent_with_options;
use crate::desktop_commands::agent::worker_submit_thread_turn_with_options;
use crate::desktop_commands::agent::WorkerSubmitThreadTurnInput;
use crate::desktop_commands::session::worker_turn_runtime_state_with_options;
use crate::desktop_commands::thread::worker_thread_request_with_options;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn worker_submit_thread_turn_creates_thread_and_runs_native_agent() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "thread-first answer" }]
            }
        }
    });

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "answer from a new thread" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-submit-new"
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread-first submit should run native agent");

    let thread_id = result["threadId"].as_str().expect("thread id").to_string();
    assert_eq!(result["turnId"], "turn-thread-submit-new");
    assert_eq!(result["sessionId"], thread_id);
    assert_eq!(result["agentResult"]["stopReason"], "final_response");
    assert!(result["agentResult"]["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .all(|event| event["threadId"] == thread_id));
    let trace_id = result["agentResult"]["traceContext"]["traceId"]
        .as_str()
        .expect("thread agent result should expose traceId");
    assert!(result["agentResult"]["runtimeEvents"]
        .as_array()
        .expect("runtime events should be present")
        .iter()
        .all(|event| event["traceContext"]["traceId"] == trace_id));
    assert!(result["snapshot"]["thread"]["sessionKey"].is_null());
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["kind"]["type"] == "assistant_message_completed"));
    let started = result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .find(|item| item["kind"]["type"] == "turn_started")
        .expect("thread turn start item should be present");
    assert_eq!(
        started["kind"]["payload"]["traceContext"]["traceId"],
        trace_id
    );
    let metadata = call_rust_state_service(
        &fixture.thread_store,
        config,
        WorkerRequest::new(
            "req-thread-submit-session-metadata",
            "trace-thread-submit-session-metadata",
            "thread.read",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "thread submit session metadata",
    )
    .expect("agent turn thread should be readable");
    assert_eq!(metadata["thread"]["threadId"], thread_id);
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
    let rollout_path = &rollout_paths[0];
    assert!(rollout_path.exists());
    let rollout =
        std::fs::read_to_string(rollout_path).expect("Rollout journal should be readable");
    let rollout_items = rollout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(rollout_items.iter().any(|line| {
        line["type"] == "turn_context"
            && line["payload"]["turn_id"] == "turn-thread-submit-new"
            && line["payload"]["model"] == "fixture-model"
    }));
    let turn_started = rollout_items
        .iter()
        .position(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_started")
        .unwrap();
    let turn_context = rollout_items
        .iter()
        .position(|line| line["type"] == "turn_context")
        .unwrap();
    let user_item = rollout_items
        .iter()
        .position(|line| line["type"] == "response_item" && line["payload"]["role"] == "user")
        .unwrap();
    let turn_complete = rollout_items
        .iter()
        .position(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_complete")
        .unwrap();
    assert!(turn_started < turn_context);
    assert!(turn_context < user_item);
    assert!(user_item < turn_complete);
    let history = call_rust_state_service(
        &fixture.thread_store,
        serde_json::json!({}),
        WorkerRequest::new(
            "req-thread-submit-rollout-history",
            "trace-thread-submit-rollout-history",
            "thread.history",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "thread submit Rollout history",
    )
    .expect("thread submit Rollout history should be readable");
    let messages = history["messages"]
        .as_array()
        .expect("Rollout history should contain messages");
    assert!(messages.iter().any(|message| {
        message["role"] == "user" && message["content"] == "answer from a new thread"
    }));
    let assistant = messages
        .iter()
        .find(|message| message["role"] == "assistant")
        .expect("Rollout history should contain the assistant response");
    assert_eq!(assistant["content"], "thread-first answer");
    assert!(assistant["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"]
        .as_i64()
        .is_some());
    assert_eq!(assistant["tokenUsageInfo"]["modelContextWindow"], 128_000);
}

#[test]
fn worker_submit_thread_turn_forwards_live_streaming_timeline_patches() {
    struct StreamingProvider;

    impl crate::agent::runtime::NativeAgentProvider for StreamingProvider {
        fn complete(
            &self,
            _context: &crate::agent::runtime::AgentTurnContext,
        ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
            Ok(crate::agent::runtime::NativeAgentProviderResponse {
                final_content: "streamed desktop answer".to_string(),
                reasoning_delta: None,
                usage: None,
                tool_calls: Vec::new(),
            })
        }

        fn complete_streaming(
            &self,
            context: &crate::agent::runtime::AgentTurnContext,
            observer: &mut (dyn FnMut(crate::agent::runtime::NativeAgentProviderStreamEvent)
                      + Send),
        ) -> Result<crate::agent::runtime::NativeAgentProviderResponse, String> {
            observer(
                crate::agent::runtime::NativeAgentProviderStreamEvent::ContentDelta(
                    "streamed ".to_string(),
                ),
            );
            observer(
                crate::agent::runtime::NativeAgentProviderStreamEvent::ContentDelta(
                    "desktop answer".to_string(),
                ),
            );
            self.complete(context)
        }
    }

    #[derive(Default)]
    struct LivePatchSink {
        patches: Mutex<Vec<crate::agent::runtime_protocol::AgentTimelinePatch>>,
    }

    impl crate::agent::runtime::NativeAgentTraceSink for LivePatchSink {
        fn append_trace_event(
            &self,
            _session_id: &str,
            _turn_id: &str,
            _event: &crate::agent::runtime_protocol::AgentRuntimeEventEnvelope,
        ) -> Result<(), String> {
            Ok(())
        }

        fn append_timeline_patch(
            &self,
            _session_id: &str,
            _turn_id: &str,
            patch: &crate::agent::runtime_protocol::AgentTimelinePatch,
        ) -> Result<(), String> {
            self.patches
                .lock()
                .expect("live patch sink should lock")
                .push(patch.clone());
            Ok(())
        }
    }

    let fixture = WorkspaceFixture::new();
    let services = NativeAgentRuntimeServices::new(
        Arc::new(StreamingProvider),
        Arc::new(crate::agent::runtime::FakeNativeAgentToolDispatcher),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(crate::agent::runtime::InMemoryNativeAgentCancellation::default()),
    );
    let shared = Arc::new(Mutex::new(GatewayRuntime {
        native_agent_runtime: services,
        ..GatewayRuntime::with_thread_store(fixture.thread_store.clone())
    }));
    let sink = Arc::new(LivePatchSink::default());

    let result = tauri::async_runtime::block_on(
        crate::desktop_commands::agent::worker_submit_thread_turn_with_live_trace_sink_async(
            &shared,
            WorkerSubmitThreadTurnInput {
                thread_id: None,
                input: serde_json::json!({ "content": "stream this answer" }),
                spec: serde_json::json!({
                    "runtime": "rust",
                    "turnId": "turn-thread-live-stream"
                }),
            },
            fixture.root.clone(),
            serde_json::json!({}),
            Duration::from_secs(1),
            Some(sink.clone()),
        ),
    )
    .expect("desktop thread submit should complete");

    assert_eq!(result["agentResult"]["stopReason"], "final_response");
    let patches = sink.patches.lock().expect("live patches should lock");
    let assistant_patches = patches
        .iter()
        .filter(|patch| {
            patch.item.kind == crate::agent::runtime_protocol::AgentTurnItemKind::AssistantMessage
        })
        .collect::<Vec<_>>();
    assert!(
        assistant_patches.iter().any(|patch| {
            patch.item.status
                == crate::agent::runtime_protocol::AgentTurnItemStatus::Running
        }),
        "desktop live sink should receive a running assistant patch before completion: {assistant_patches:#?}"
    );
    assert!(
        assistant_patches.iter().any(|patch| {
            patch.item.status == crate::agent::runtime_protocol::AgentTurnItemStatus::Completed
        }),
        "desktop live sink should receive the completed assistant patch"
    );
    assert!(
        assistant_patches.windows(2).all(|pair| {
            assistant_patch_content(pair[0]).len() <= assistant_patch_content(pair[1]).len()
        }),
        "streamed assistant content should grow monotonically"
    );

    fn assistant_patch_content(patch: &crate::agent::runtime_protocol::AgentTimelinePatch) -> &str {
        match &patch.item.data {
            crate::agent::runtime_protocol::AgentTurnItemData::AssistantMessage {
                content, ..
            } => content,
            _ => "",
        }
    }
}

#[test]
fn thread_owned_compaction_commits_installed_checkpoint_before_finalization() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": {
            "provider": "fixture",
            "model": "fixture-model",
            "contextWindowTokens": 800,
            "contextWindowStrategy": "compact",
            "compactTriggerPercent": 50,
            "compactSummaryMaxTokens": 32
        } },
        "providers": { "fixture": { "responses": [
            { "content": "thread compact summary" },
            { "content": "thread compact answer" }
        ] } }
    });

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "current question" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-context-commit",
                "messages": [
                    { "role": "user", "content": "old context ".repeat(200) },
                    { "role": "assistant", "content": "old answer ".repeat(200) },
                    { "role": "user", "content": "current question" }
                ]
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread compaction should commit through thread authority");

    let compactions = result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .filter(|item| item["kind"]["type"] == "context_compaction")
        .collect::<Vec<_>>();
    assert_eq!(compactions.len(), 1);
    assert!(compactions.iter().all(|item| {
        item["kind"]["payload"]["payload"]["contextCheckpoint"]["checkpointStage"] == "finalized"
    }));
    assert!(compactions.iter().all(|item| {
        let checkpoint = &item["kind"]["payload"]["payload"]["contextCheckpoint"];
        checkpoint["windowNumber"] == 1 && checkpoint["windowId"] == checkpoint["contextId"]
    }));
    let thread_id = result["threadId"].as_str().unwrap();
    let metadata = call_rust_state_service(
        &fixture.thread_store,
        config,
        WorkerRequest::new(
            "req-thread-compact-rollout-metadata",
            "trace-thread-compact-rollout-metadata",
            "thread.read",
            serde_json::json!({ "threadId": thread_id }),
        ),
        "thread compact Rollout metadata",
    )
    .expect("thread compact Rollout should be readable");
    assert_eq!(metadata["thread"]["threadId"], thread_id);
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
    let rollout = std::fs::read_to_string(&rollout_paths[0]).unwrap();
    let compacted = rollout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["type"] == "compacted")
        .collect::<Vec<_>>();
    assert_eq!(compacted.len(), 2);
    assert!(compacted
        .iter()
        .any(|line| line["payload"]["checkpointStage"] == "installed"));
    assert!(compacted
        .iter()
        .any(|line| line["payload"]["checkpointStage"] == "finalized"));
}

#[test]
fn thread_owned_terminal_reentry_uses_rollout_authority_after_restart() {
    let fixture = WorkspaceFixture::new();
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": { "fixture": { "responses": [{ "content": "terminal answer" }] } }
    });
    let first_shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let first = worker_submit_thread_turn_with_options(
        &first_shared,
        WorkerSubmitThreadTurnInput {
            thread_id: None,
            input: serde_json::json!({ "content": "complete once" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-terminal-reentry"
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("initial thread turn should complete");
    let thread_id = first["threadId"].as_str().unwrap().to_string();

    let restarted_shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let retry = worker_submit_thread_turn_with_options(
        &restarted_shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some(thread_id.clone()),
            input: serde_json::json!({ "content": "complete once" }),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-terminal-reentry"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("terminal retry should return a stable rejection");

    assert_eq!(retry["threadId"], thread_id);
    assert_eq!(retry["agentResult"]["stopReason"], "terminal_turn");
    assert_eq!(retry["snapshot"]["thread"]["status"], "idle");
    let rollout_paths = compatibility_thread_log_paths(&fixture.root);
    assert_eq!(rollout_paths.len(), 1, "{rollout_paths:?}");
}

#[test]
fn worker_submit_thread_turn_uses_thread_id_as_rollout_id() {
    let fixture = WorkspaceFixture::new();
    let working_directory = fixture.root.join("existing-thread-project");
    std::fs::create_dir_all(working_directory.join(".git"))
        .expect("existing thread project marker should create");
    std::fs::write(
        working_directory.join("AGENTS.md"),
        "existing thread project instructions",
    )
    .expect("existing thread project instructions should write");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "existing thread answer" }]
            }
        }
    });
    let create_request = next_worker_request_correlation();
    let thread = call_rust_state_service(
        &fixture.thread_store,
        config.clone(),
        WorkerRequest::new(
            create_request.id("existing-thread-create"),
            create_request.trace_id("existing-thread-create"),
            "thread.create",
            serde_json::json!({
                "threadId": "thread-existing-submit",
                "sessionKey": "session-existing-submit",
                "title": "Existing thread",
                "metadata": {
                    "workingDirectory": working_directory
                }
            }),
        ),
        "existing thread create",
    )
    .expect("existing thread should create");

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some(
                thread["threadId"]
                    .as_str()
                    .expect("created thread id")
                    .to_string(),
            ),
            input: serde_json::json!("continue existing thread"),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-submit-existing"
            }),
        },
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("existing thread submit should run native agent");

    assert_eq!(result["threadId"], "thread-existing-submit");
    assert_eq!(result["sessionId"], "thread-existing-submit");
    assert_eq!(result["agentResult"]["sessionId"], "thread-existing-submit");
    assert_eq!(
        result["snapshot"]["thread"]["threadId"],
        "thread-existing-submit"
    );
    assert_eq!(
        result["agentResult"]["instructionProvenance"]["workingDirectory"],
        working_directory.display().to_string()
    );
    assert!(result["agentResult"]["instructionProvenance"]["sources"]
        .as_array()
        .expect("thread instruction provenance should list sources")
        .iter()
        .any(|source| source["kind"] == "project_agents"));
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["turnId"] == "turn-thread-submit-existing"));
    let run_request = next_worker_request_correlation();
    let persisted_run = call_rust_state_service(
        &fixture.thread_store,
        config,
        WorkerRequest::new(
            run_request.id("existing-thread-agent-turn-read"),
            run_request.trace_id("existing-thread-agent-turn-read"),
            "thread.turn.get",
            serde_json::json!({
                "threadId": "thread-existing-submit",
                "turnId": "turn-thread-submit-existing"
            }),
        ),
        "existing thread agent turn read",
    )
    .expect("existing thread agent turn should persist");
    assert_eq!(
        persisted_run["instructionProvenance"]["workingDirectory"],
        working_directory.display().to_string()
    );
}

#[test]
fn worker_submit_thread_turn_does_not_require_a_session_key() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{ "content": "backfilled thread answer" }]
            }
        }
    });
    let create_request = next_worker_request_correlation();
    call_rust_state_service(
        &fixture.thread_store,
        config.clone(),
        WorkerRequest::new(
            create_request.id("thread-without-session-create"),
            create_request.trace_id("thread-without-session-create"),
            "thread.create",
            serde_json::json!({
                "threadId": "thread-submit-backfill",
                "title": "Existing thread without session"
            }),
        ),
        "existing thread without session create",
    )
    .expect("thread without session key should create");

    let result = worker_submit_thread_turn_with_options(
        &shared,
        WorkerSubmitThreadTurnInput {
            thread_id: Some("thread-submit-backfill".to_string()),
            input: serde_json::json!("continue backfilled thread"),
            spec: serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-thread-submit-backfill"
            }),
        },
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread submit should use the thread id as the Rollout id");

    assert_eq!(result["threadId"], "thread-submit-backfill");
    assert_eq!(result["sessionId"], "thread-submit-backfill");
    assert!(result["snapshot"]["thread"]["sessionKey"].is_null());
    assert!(result["snapshot"]["items"]
        .as_array()
        .expect("thread items should be present")
        .iter()
        .any(|item| item["turnId"] == "turn-thread-submit-backfill"));
}

#[test]
fn worker_thread_commands_expose_thread_service_surface() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({});

    let created = worker_thread_request_with_options(
        &shared,
        "test-thread-command-create",
        "thread.create",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "sessionKey": "session-command-surface",
            "title": "Command surface thread"
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread create command should work");
    assert_eq!(created["threadId"], "thread-command-surface");

    let list = worker_thread_request_with_options(
        &shared,
        "test-thread-command-list",
        "thread.list",
        serde_json::json!({ "includeArchived": true }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread list command should work");
    assert!(list["threads"]
        .as_array()
        .expect("threads should be an array")
        .iter()
        .any(|thread| thread["threadId"] == "thread-command-surface"));

    let search = worker_thread_request_with_options(
        &shared,
        "test-thread-command-search",
        "thread.search",
        serde_json::json!({
            "query": "surface",
            "includeArchived": true,
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread search command should work");
    assert!(search["threads"]
        .as_array()
        .expect("search threads should be an array")
        .iter()
        .any(|thread| thread["threadId"] == "thread-command-surface"));

    let read = worker_thread_request_with_options(
        &shared,
        "test-thread-command-read",
        "thread.read",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread read command should work");
    assert_eq!(read["thread"]["threadId"], "thread-command-surface");

    let resumed = worker_thread_request_with_options(
        &shared,
        "test-thread-command-resume",
        "thread.resume",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread resume command should work");
    assert_eq!(resumed["thread"]["threadId"], "thread-command-surface");

    let activity = worker_thread_request_with_options(
        &shared,
        "test-thread-command-activity",
        "thread.activity",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread activity command should work");
    assert_eq!(activity["threadId"], "thread-command-surface");

    let status = worker_thread_request_with_options(
        &shared,
        "test-thread-command-status",
        "thread.status",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread status command should work");
    assert_eq!(status["thread"]["threadId"], "thread-command-surface");

    let updated = worker_thread_request_with_options(
        &shared,
        "test-thread-command-update-metadata",
        "thread.update_metadata",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "metadata": { "title": "Renamed command surface" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread update metadata command should work");
    assert_eq!(updated["title"], "Renamed command surface");

    let registry = worker_thread_request_with_options(
        &shared,
        "test-thread-command-agent-registry",
        "thread.agent_registry",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread agent registry command should work");
    assert_eq!(registry["rootThreadId"], "thread-command-surface");

    let archived = worker_thread_request_with_options(
        &shared,
        "test-thread-command-archive",
        "thread.archive",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread archive command should work");
    assert_eq!(archived["status"], "archived");

    let unarchived = worker_thread_request_with_options(
        &shared,
        "test-thread-command-unarchive",
        "thread.unarchive",
        serde_json::json!({ "threadId": "thread-command-surface" }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread unarchive command should work");
    assert_eq!(unarchived["status"], "empty");

    let started = worker_thread_request_with_options(
        &shared,
        "test-thread-command-start-turn",
        "thread.start_turn",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "turnId": "turn-command-surface",
            "input": { "text": "start from command" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread start turn command should work");
    assert_eq!(started["turn"]["turnId"], "turn-command-surface");
    assert!(
        started["appendedItems"]
            .as_array()
            .expect("start appended items should be an array")
            .len()
            >= 2
    );

    let continued = worker_thread_request_with_options(
        &shared,
        "test-thread-command-continue-turn",
        "thread.continue_turn",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "turnId": "turn-command-surface",
            "input": { "text": "continue from command" }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread continue turn command should work");
    assert!(continued["appendedItems"]
        .as_array()
        .expect("continue appended items should be an array")
        .iter()
        .any(|item| item["turnId"] == "turn-command-surface"));

    let applied = worker_thread_request_with_options(
        &shared,
        "test-thread-command-apply-op",
        "thread.apply_op",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "op": {
                "type": "tool_call_started",
                "turnId": "turn-command-surface",
                "toolCallId": "tool-command-surface",
                "toolName": "workspace.read_file",
                "args": { "path": "README.md" }
            }
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("thread apply op command should work");
    assert!(applied["appendedItems"]
        .as_array()
        .expect("apply-op appended items should be an array")
        .iter()
        .any(|item| item["kind"]["type"] == "tool_call_started"));

    let task_runtime = {
        let runtime = lock_runtime(&shared);
        runtime.native_agent_runtime.task_runtime()
    };
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let owned_handle = task_runtime
        .start_blocking(
            crate::runtime::turn_execution::StartAgentTurn::new(
                "turn-command-surface",
                "session-command-surface",
            ),
            move || {
                release_receiver
                    .recv()
                    .expect("owned thread command task release should arrive");
                Ok(serde_json::json!({
                    "runtime": "rust",
                    "turnId": "turn-command-surface",
                    "sessionId": "session-command-surface",
                    "stopReason": "final_response"
                }))
            },
        )
        .expect("thread command run should have an active owner");

    let interrupted = worker_thread_request_with_options(
        &shared,
        "test-thread-command-interrupt",
        "thread.interrupt",
        serde_json::json!({
            "threadId": "thread-command-surface",
            "turnId": "turn-command-surface",
            "reason": "test interrupt"
        }),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("thread interrupt command should work");
    assert!(interrupted["appendedItems"]
        .as_array()
        .expect("interrupt appended items should be an array")
        .iter()
        .any(|item| item["kind"]["type"] == "cancelled"));
    assert_eq!(
        interrupted["taskCancellation"]["task"]["state"],
        "cancel_requested"
    );
    assert_eq!(
        owned_handle
            .wait()
            .expect("thread interrupt should complete the owned handle")["stopReason"],
        "cancelled"
    );
    release_sender
        .send(())
        .expect("owned thread command task should release");
    for _ in 0..100 {
        if task_runtime.draining_count() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(task_runtime.draining_count(), 0);
}

#[test]
fn native_agent_semantic_sink_updates_runtime_state_before_final_persistence() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({});
    let session_id = "websocket:chat-trace-sink";
    let turn_id = "turn-trace-sink";
    let spec = serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
    });
    persist_native_agent_turn_start(spec, &fixture.thread_store, config.clone())
        .expect("run start should persist");
    let mut emitter = crate::agent::runtime_protocol::AgentTurnEmitter::new(session_id, turn_id);
    let event = emitter.awaiting_approval(
        "unix-ms:1",
        "approval-trace-sink",
        serde_json::json!({
            "toolName": "workspace.write_file",
            "summary": "Approval required: workspace.write_file",
        }),
    );
    let sink = crate::agent::bridge::AgentTurnSemanticSink::new(
        fixture.thread_store.clone(),
        config.clone(),
    );

    sink.append_trace_event(session_id, turn_id, &event)
        .expect("trace sink should append event");
    let runtime_state = worker_turn_runtime_state_with_options(
        &shared,
        session_id.to_string(),
        turn_id.to_string(),
        fixture.root.clone(),
        config,
        Duration::from_millis(10),
    )
    .expect("runtime state should read appended trace event");

    assert!(runtime_state["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array")
        .iter()
        .any(|event| event["eventName"] == "agent.awaiting_approval"));
    let approval_item = runtime_state["timeline"]["items"]
        .as_array()
        .expect("timeline items should be an array")
        .iter()
        .find(|item| item["kind"] == "approval")
        .expect("approval item should be restored");
    assert_eq!(approval_item["status"], "waiting");
    assert_eq!(approval_item["data"]["approvalId"], "approval-trace-sink");
}

#[test]
fn worker_run_agent_persists_failed_tool_run_with_typed_results() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
        "providers": {
            "fixture": {
                "responses": [{
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-before-tool-error",
                            "name": "memory.recall",
                            "argumentsJson": "{\"query\":\"Prepare failure\"}",
                            "result": { "content": "fixture result should not be used" }
                        },
                        {
                            "id": "call-tool-error",
                            "name": "memory.search",
                            "argumentsJson": "{not json",
                            "result": { "content": "unused" }
                        }
                    ]
                }]
            }
        }
    });

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-tool-error-persist",
            "sessionId": "websocket:chat-tool-error-persist",
            "maxIterations": 3,
            "selectedTools": ["memory.recall", "memory.search"],
            "messages": [{ "role": "user", "content": "read then fail" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return structured tool error");
    let run = read_agent_turn_record(
        &fixture.thread_store,
        config,
        "websocket:chat-tool-error-persist",
        "turn-tool-error-persist",
    );

    assert_eq!(result["stopReason"], "tool_error");
    assert_eq!(run["status"], "failed");
    assert_eq!(run["stopReason"], "tool_error");
    assert_eq!(
        run["completedToolResults"][0]["toolCallId"],
        "call-before-tool-error"
    );
    assert_eq!(
        run["completedToolResults"][1]["toolCallId"],
        "call-tool-error"
    );
    assert!(run["completedToolResults"][1].get("status").is_none());
    assert!(run["completedToolResults"][1]["summary"]
        .as_str()
        .is_some_and(|summary| summary.contains("invalid JSON")));
    assert!(run.get("traceEvents").is_none());
}

#[test]
fn worker_run_agent_persists_cancelled_run_as_cancelled() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({});
    lock_runtime(&shared)
        .native_agent_runtime
        .cancel("turn-cancel-persist");

    let result = worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-cancel-persist",
            "sessionId": "websocket:chat-cancel-persist",
            "messages": [{ "role": "user", "content": "cancel me" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should return structured cancellation");
    let run = read_agent_turn_record(
        &fixture.thread_store,
        config,
        "websocket:chat-cancel-persist",
        "turn-cancel-persist",
    );

    assert_eq!(result["stopReason"], "cancelled");
    assert_eq!(run["status"], "cancelled");
    assert_eq!(run["phase"], "cancelled");
    assert_eq!(run["checkpoint"]["phase"], "cancelled");
}

#[test]
fn worker_run_agent_projects_redacted_bounded_tool_result() {
    let fixture = WorkspaceFixture::new();
    fixture.write("README.md", "secret-token ABCDEFGHIJKLMNOP");
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let config = serde_json::json!({
        "agents": {
            "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "maxToolResultChars": 12
            }
        },
        "providers": {
            "fixture": {
                "api_key": "secret-token",
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-redacted",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}",
                            "result": { "content": "secret-token ABCDEFGHIJKLMNOP" }
                        }]
                    },
                    { "content": "bounded final" }
                ]
            }
        }
    });

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-redacted-trace",
            "sessionId": "websocket:chat-redacted-trace",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read bounded" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete bounded tool run");
    let run = read_agent_turn_record(
        &fixture.thread_store,
        config,
        "websocket:chat-redacted-trace",
        "turn-redacted-trace",
    );
    let serialized = run.to_string();
    assert!(!serialized.contains("secret-token"));
    assert!(!run["completedToolResults"][0]["summary"]
        .to_string()
        .contains("secret-token"));
    assert!(run["completedToolResults"][0].get("envelope").is_none());
}

#[test]
fn worker_run_agent_omits_large_raw_tool_trace_from_persisted_run_record() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    let large_output = "A".repeat(12_000);
    fixture.write("large.txt", &large_output);
    let config = serde_json::json!({
        "agents": {
            "defaults": {
                "provider": "fixture",
                "model": "fixture-model",
                "maxToolResultChars": 128
            }
        },
        "providers": {
            "fixture": {
                "responses": [
                    {
                        "content": "",
                        "toolCalls": [{
                            "id": "call-large",
                            "name": "workspace.read_file",
                            "argumentsJson": "{\"path\":\"large.txt\"}",
                            "result": { "content": large_output }
                        }]
                    },
                    { "content": "large final" }
                ]
            }
        }
    });

    worker_run_agent_with_options(
        &shared,
        serde_json::json!({
            "runtime": "rust",
            "turnId": "turn-large-trace",
            "sessionId": "websocket:chat-large-trace",
            "maxIterations": 2,
            "messages": [{ "role": "user", "content": "read large" }]
        }),
        fixture.root.clone(),
        config.clone(),
        Duration::from_millis(10),
    )
    .expect("Rust runtime should complete large tool run");
    let run = read_agent_turn_record(
        &fixture.thread_store,
        config,
        "websocket:chat-large-trace",
        "turn-large-trace",
    );
    let serialized = run.to_string();

    assert!(
        serialized.len() < 30_000,
        "turn record was {} bytes",
        serialized.len()
    );
    assert!(!serialized.contains(&"A".repeat(512)));
    assert!(run["completedToolResults"][0].get("envelope").is_none());
}

#[test]
fn worker_rust_agent_restore_rejects_unknown_checkpoint_schema_version() {
    let fixture = WorkspaceFixture::new();
    let shared = Arc::new(Mutex::new(GatewayRuntime::with_thread_store(
        fixture.thread_store.clone(),
    )));
    {
        let services = {
            let runtime = lock_runtime(&shared);
            runtime.native_agent_runtime.clone()
        };
        services.save_checkpoint(
            "websocket:chat-future-checkpoint",
            serde_json::json!({
                "schemaVersion": 999,
                "runtime": "rust",
                "turnId": "turn-future-checkpoint",
                "sessionId": "websocket:chat-future-checkpoint",
                "phase": "awaiting_approval"
            }),
        );
    }

    let error = worker_restore_agent_checkpoint_with_options(
        &shared,
        "websocket:chat-future-checkpoint".to_string(),
        fixture.root.clone(),
        serde_json::json!({ "desktop": { "nativeAgentRuntime": "rust" } }),
        Duration::from_millis(10),
    )
    .expect_err("unknown checkpoint versions should fail visibly");

    assert!(
        error.contains("unsupported Rust agent checkpoint schemaVersion 999"),
        "unexpected error: {error}"
    );
}
