use super::model::{
    extract_memories, model_config_for_test, model_request_for_test, parse_diff_for_test,
    parse_extraction_for_test, select_diff, TurnEvidence,
};
use super::runtime::successful_tool_result_for_test;
use super::{
    normalized_workspace_path, ExtractedMemory, MemoryScope, MemoryStore, SelectionAdd,
    SelectionDiff, SelectionUpdate,
};
use crate::protocol::capability::default_desktop_capability_policy;
use crate::threads::domain::{ThreadMetadata, ThreadRecord, ThreadStatus};
use crate::threads::workspace_store::WorkspaceThreadStore;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct MemoryFixture {
    root: PathBuf,
    store: MemoryStore,
    workspace_path: String,
}

impl MemoryFixture {
    fn new(label: &str) -> Self {
        let nonce = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tinybot-memory-{label}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = MemoryStore::for_workspace(&root);
        store.initialize().unwrap();
        let workspace_path = normalized_workspace_path(&root).unwrap();
        Self {
            root,
            store,
            workspace_path,
        }
    }

    fn extract(&self, thread_id: &str, turn_id: &str, memories: Vec<ExtractedMemory>) {
        self.extract_for_workspace(thread_id, turn_id, &self.workspace_path, memories);
    }

    fn extract_for_workspace(
        &self,
        thread_id: &str,
        turn_id: &str,
        workspace_path: &str,
        memories: Vec<ExtractedMemory>,
    ) {
        self.store
            .enqueue_turn(&self.workspace_path, thread_id, turn_id, workspace_path)
            .unwrap();
        let pending = self.store.pending_turns(&self.workspace_path, 10).unwrap();
        let pending = pending
            .iter()
            .find(|pending| pending.thread_id == thread_id && pending.turn_id == turn_id)
            .unwrap();
        self.store.complete_extraction(pending, &memories).unwrap();
    }
}

impl Drop for MemoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn sqlite_pipeline_records_fragments_and_applies_selection_diff() {
    let fixture = MemoryFixture::new("pipeline");
    fixture.extract(
        "thread-1",
        "turn-1",
        vec![
            ExtractedMemory {
                scope: MemoryScope::User,
                content: "User prefers concise answers.".to_string(),
            },
            ExtractedMemory {
                scope: MemoryScope::Workspace,
                content: "This workspace uses Rust.".to_string(),
            },
        ],
    );

    let input = fixture.store.phase2_input().unwrap().unwrap();
    assert_eq!(input.fragments.len(), 2);
    assert!(input.active.is_empty());
    let changed = fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![
                    SelectionAdd {
                        scope: MemoryScope::User,
                        path: None,
                        content: "User prefers concise answers.".to_string(),
                    },
                    SelectionAdd {
                        scope: MemoryScope::Workspace,
                        path: Some(fixture.workspace_path.clone()),
                        content: "This workspace uses Rust.".to_string(),
                    },
                ],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap();

    assert!(changed);
    assert!(fixture.store.phase2_input().unwrap().is_none());
    let snapshot = fixture
        .store
        .render_thread_snapshot(&fixture.workspace_path)
        .unwrap();
    assert!(snapshot.contains("## User memory"));
    assert!(snapshot.contains("User prefers concise answers."));
    assert!(snapshot.contains("## Workspace memory"));
    assert!(snapshot.contains("This workspace uses Rust."));
}

#[test]
fn active_memories_returns_the_canonical_set_in_stable_scope_order() {
    let fixture = MemoryFixture::new("active-view");
    fixture.extract(
        "thread-1",
        "turn-1",
        vec![
            ExtractedMemory {
                scope: MemoryScope::Workspace,
                content: "This workspace uses Rust.".to_string(),
            },
            ExtractedMemory {
                scope: MemoryScope::User,
                content: "User prefers concise answers.".to_string(),
            },
        ],
    );
    let input = fixture.store.phase2_input().unwrap().unwrap();
    fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![
                    SelectionAdd {
                        scope: MemoryScope::Workspace,
                        path: Some(fixture.workspace_path.clone()),
                        content: "This workspace uses Rust.".to_string(),
                    },
                    SelectionAdd {
                        scope: MemoryScope::User,
                        path: None,
                        content: "User prefers concise answers.".to_string(),
                    },
                ],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap();

    let active = fixture.store.active_memories().unwrap();
    assert_eq!(active.len(), 2);
    assert_eq!(active[0].scope, MemoryScope::User);
    assert_eq!(active[0].content, "User prefers concise answers.");
    assert_eq!(active[1].scope, MemoryScope::Workspace);
    assert_eq!(
        active[1].path.as_deref(),
        Some(fixture.workspace_path.as_str())
    );
}

#[test]
fn processed_turn_is_idempotent() {
    let fixture = MemoryFixture::new("idempotent");
    let memory = ExtractedMemory {
        scope: MemoryScope::User,
        content: "User prefers dark mode.".to_string(),
    };
    fixture.extract("thread-1", "turn-1", vec![memory.clone()]);
    fixture.extract("thread-1", "turn-1", vec![memory]);

    let input = fixture.store.phase2_input().unwrap().unwrap();
    assert_eq!(input.fragments.len(), 1);
}

#[test]
fn pending_turns_are_isolated_by_thread_store_path() {
    let fixture = MemoryFixture::new("pending-isolation");
    let other_thread_store_path = fixture.root.join("other-store").display().to_string();
    fixture
        .store
        .enqueue_turn(
            &fixture.workspace_path,
            "thread-shared",
            "turn-shared",
            &fixture.workspace_path,
        )
        .unwrap();
    fixture
        .store
        .enqueue_turn(
            &other_thread_store_path,
            "thread-shared",
            "turn-shared",
            &fixture.workspace_path,
        )
        .unwrap();

    let local = fixture
        .store
        .pending_turns(&fixture.workspace_path, 10)
        .unwrap();
    let other = fixture
        .store
        .pending_turns(&other_thread_store_path, 10)
        .unwrap();
    assert_eq!(local.len(), 1);
    assert_eq!(other.len(), 1);
    assert_eq!(local[0].thread_store_path, fixture.workspace_path);
    assert_eq!(other[0].thread_store_path, other_thread_store_path);
}

#[test]
fn invalid_selection_diff_does_not_advance_watermark() {
    let fixture = MemoryFixture::new("invalid-diff");
    fixture.extract(
        "thread-1",
        "turn-1",
        vec![ExtractedMemory {
            scope: MemoryScope::Workspace,
            content: "This workspace uses TypeScript.".to_string(),
        }],
    );
    let input = fixture.store.phase2_input().unwrap().unwrap();
    let error = fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![SelectionAdd {
                    scope: MemoryScope::Workspace,
                    path: Some(fixture.root.join("other").display().to_string()),
                    content: "This workspace uses TypeScript.".to_string(),
                }],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap_err();

    assert!(error.contains("unknown path"));
    let error = fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![SelectionAdd {
                    scope: MemoryScope::User,
                    path: None,
                    content: "This workspace uses TypeScript.".to_string(),
                }],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap_err();
    assert!(error.contains("user-scoped fragment"));
    assert_eq!(
        fixture.store.phase2_input().unwrap().unwrap().watermark,
        input.watermark
    );
}

#[test]
fn selection_diff_can_update_and_remove_only_known_memories() {
    let fixture = MemoryFixture::new("update-remove");
    fixture.extract(
        "thread-1",
        "turn-1",
        vec![ExtractedMemory {
            scope: MemoryScope::User,
            content: "User prefers short answers.".to_string(),
        }],
    );
    let first = fixture.store.phase2_input().unwrap().unwrap();
    fixture
        .store
        .apply_selection_diff(
            &first,
            &SelectionDiff {
                add: vec![SelectionAdd {
                    scope: MemoryScope::User,
                    path: None,
                    content: "User prefers short answers.".to_string(),
                }],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap();
    fixture.extract(
        "thread-1",
        "turn-2",
        vec![ExtractedMemory {
            scope: MemoryScope::User,
            content: "User now prefers detailed answers.".to_string(),
        }],
    );
    let second = fixture.store.phase2_input().unwrap().unwrap();
    let memory_id = second.active[0].id;
    fixture
        .store
        .apply_selection_diff(
            &second,
            &SelectionDiff {
                add: Vec::new(),
                update: vec![SelectionUpdate {
                    id: memory_id,
                    content: "User prefers detailed answers.".to_string(),
                }],
                remove: Vec::new(),
            },
        )
        .unwrap();
    let snapshot = fixture
        .store
        .render_thread_snapshot(&fixture.workspace_path)
        .unwrap();
    assert!(snapshot.contains("User prefers detailed answers."));
    assert!(!snapshot.contains("short answers"));
}

#[test]
fn phase2_excludes_active_memories_from_unaffected_workspaces() {
    let fixture = MemoryFixture::new("phase2-scope-isolation");
    let other_root = fixture.root.join("other-workspace");
    fs::create_dir_all(&other_root).unwrap();
    let other_workspace_path = normalized_workspace_path(&other_root).unwrap();

    for (turn_id, workspace_path, content) in [
        (
            "turn-workspace-a",
            fixture.workspace_path.as_str(),
            "Workspace A uses Rust.",
        ),
        (
            "turn-workspace-b",
            other_workspace_path.as_str(),
            "Workspace B uses TypeScript.",
        ),
    ] {
        fixture.extract_for_workspace(
            "thread-1",
            turn_id,
            workspace_path,
            vec![ExtractedMemory {
                scope: MemoryScope::Workspace,
                content: content.to_string(),
            }],
        );
        let input = fixture.store.phase2_input().unwrap().unwrap();
        fixture
            .store
            .apply_selection_diff(
                &input,
                &SelectionDiff {
                    add: vec![SelectionAdd {
                        scope: MemoryScope::Workspace,
                        path: Some(workspace_path.to_string()),
                        content: content.to_string(),
                    }],
                    update: Vec::new(),
                    remove: Vec::new(),
                },
            )
            .unwrap();
    }

    fixture.extract(
        "thread-1",
        "turn-workspace-a-update",
        vec![ExtractedMemory {
            scope: MemoryScope::Workspace,
            content: "Workspace A now uses stable Rust.".to_string(),
        }],
    );
    let input = fixture.store.phase2_input().unwrap().unwrap();
    assert_eq!(input.active.len(), 1);
    assert_eq!(
        input.active[0].path.as_deref(),
        Some(fixture.workspace_path.as_str())
    );
    assert!(!input.active[0].content.contains("TypeScript"));
}

#[test]
fn markdown_view_is_atomic_and_not_rewritten_when_unchanged() {
    let fixture = MemoryFixture::new("markdown");
    assert!(fixture.store.write_latest_markdown().unwrap());
    assert!(!fixture.store.write_latest_markdown().unwrap());
    assert_eq!(
        fs::read_to_string(fixture.store.markdown_path()).unwrap(),
        "# Long-term memory\n\n_No active memories._\n"
    );
    assert!(fixture.store.database_path().exists());
}

#[test]
fn model_json_parsers_accept_fences_and_reject_wrong_shapes() {
    let extracted = parse_extraction_for_test(
        "```json\n{\"memories\":[{\"scope\":\"user\",\"content\":\"Uses dark mode.\"}]}\n```",
    )
    .unwrap();
    assert_eq!(extracted.len(), 1);
    assert_eq!(extracted[0].scope, MemoryScope::User);

    let diff = parse_diff_for_test(
        "{\"add\":[],\"update\":[{\"id\":7,\"content\":\"Updated.\"}],\"remove\":[8]}",
    )
    .unwrap();
    assert_eq!(diff.update[0].id, 7);
    assert!(parse_extraction_for_test("{\"content\":\"wrong\"}").is_err());
}

#[test]
fn memory_models_use_the_configured_provider_protocol() {
    let extraction = tauri::async_runtime::block_on(extract_memories(
        &fixture_model_config(
            "{\"memories\":[{\"scope\":\"workspace\",\"content\":\"Uses Rust.\"}]}",
        ),
        &TurnEvidence {
            user_messages: vec!["This project uses Rust.".to_string()],
            successful_tool_results: Vec::new(),
        },
    ))
    .unwrap();
    assert_eq!(extraction[0].scope, MemoryScope::Workspace);

    let diff = tauri::async_runtime::block_on(select_diff(
        &fixture_model_config(
            "{\"add\":[{\"scope\":\"workspace\",\"path\":\"D:\\\\workspace\",\"content\":\"Uses Rust.\"}],\"update\":[],\"remove\":[]}",
        ),
        &super::Phase2Input {
            watermark: 0,
            through_fragment_id: 1,
            active: Vec::new(),
            fragments: vec![super::MemoryRecord {
                id: 1,
                scope: MemoryScope::Workspace,
                path: Some(r"D:\workspace".to_string()),
                content: "Uses Rust.".to_string(),
            }],
        },
    ))
    .unwrap();
    assert_eq!(diff.add[0].content, "Uses Rust.");
}

#[test]
fn memory_models_use_the_responses_provider_protocol() {
    let extraction = tauri::async_runtime::block_on(extract_memories(
        &fixture_responses_model_config(
            "{\"memories\":[{\"scope\":\"workspace\",\"content\":\"Uses Rust.\"}]}",
        ),
        &TurnEvidence {
            user_messages: vec!["This project uses Rust.".to_string()],
            successful_tool_results: Vec::new(),
        },
    ))
    .unwrap();

    assert_eq!(extraction[0].scope, MemoryScope::Workspace);
    assert_eq!(extraction[0].content, "Uses Rust.");
}

#[test]
fn memory_model_request_uses_the_synchronized_defaults_after_a_provider_switch() {
    let mut config = json!({
        "agents": {
            "defaults": {
                "activeProfile": "deepseek-default",
                "model": "deepseek-v4-pro"
            }
        },
        "providers": {
            "profiles": {
                "deepseek-default": {
                    "provider": "deepseek",
                    "apiBase": "https://api.deepseek.com",
                    "apiMode": "responses"
                },
                "zai-default": {
                    "provider": "zai",
                    "apiBase": "https://open.bigmodel.cn/api/paas/v4",
                    "apiMode": "chat_completions"
                }
            }
        }
    });
    let defaults = config.pointer_mut("/agents/defaults").unwrap();
    defaults["activeProfile"] = json!("zai-default");
    defaults["model"] = json!("glm-5.3-flash");

    let request = model_request_for_test(&config).unwrap();
    let provider = crate::agent::provider::resolve_provider_profile(&config, None, None).unwrap();

    assert_eq!(request["model"], "glm-5.3-flash");
    assert_eq!(provider.provider_id, "zai");
    assert_eq!(
        provider.api_base.as_deref(),
        Some("https://open.bigmodel.cn/api/paas/v4")
    );
}

#[test]
fn memory_model_request_uses_an_explicit_memory_override() {
    let config = json!({
        "agents": {
            "defaults": {
                "activeProfile": "deepseek-default",
                "model": "deepseek-v4-pro"
            }
        },
        "memory": {
            "activeProfile": "zai-default",
            "model": "glm-5.3-flash"
        },
        "providers": {
            "profiles": {
                "deepseek-default": { "provider": "deepseek" },
                "zai-default": { "provider": "zai" }
            }
        }
    });

    let request = model_request_for_test(&config).unwrap();
    let effective = model_config_for_test(&config).unwrap();
    let provider =
        crate::agent::provider::resolve_provider_profile(&effective, None, None).unwrap();

    assert_eq!(request["model"], "glm-5.3-flash");
    assert_eq!(provider.provider_id, "zai");
}

#[test]
fn memory_model_request_uses_responses_shape_for_a_responses_profile() {
    let config = json!({
        "agents": {
            "defaults": {
                "activeProfile": "openai-responses",
                "model": "gpt-5"
            }
        },
        "providers": {
            "profiles": {
                "openai-responses": {
                    "provider": "openai",
                    "apiMode": "responses"
                }
            }
        }
    });

    let request = model_request_for_test(&config).unwrap();

    assert!(request.get("messages").is_none());
    assert_eq!(request["input"][0]["role"], "system");
    assert_eq!(request["input"][1]["role"], "user");
    assert_eq!(request["store"], false);
}

#[test]
fn incomplete_memory_model_override_fails_clearly() {
    let config = json!({
        "agents": {
            "defaults": {
                "activeProfile": "deepseek-default",
                "model": "deepseek-v4-pro"
            }
        },
        "memory": { "model": "glm-5.3-flash" }
    });

    assert_eq!(
        model_request_for_test(&config).unwrap_err(),
        "memory model override requires both memory.activeProfile and memory.model"
    );
}

fn fixture_model_config(content: &str) -> serde_json::Value {
    json!({
        "agents": {
            "defaults": {
                "provider": "fixture",
                "model": "fixture-model"
            }
        },
        "providers": {
            "fixture": {
                "responses": [{ "content": content }]
            }
        }
    })
}

fn fixture_responses_model_config(content: &str) -> serde_json::Value {
    json!({
        "agents": {
            "defaults": {
                "activeProfile": "fixture-responses",
                "model": "fixture-model"
            }
        },
        "providers": {
            "profiles": {
                "fixture-responses": {
                    "provider": "fixture",
                    "apiMode": "responses"
                }
            },
            "fixture": {
                "responses": [{ "content": content }]
            }
        }
    })
}

#[test]
fn only_successful_tool_results_are_fact_evidence() {
    assert!(successful_tool_result_for_test(&json!({
        "toolName": "workspace.read_file",
        "summary": { "status": "ok", "structured": { "value": 1 } }
    })));
    assert!(!successful_tool_result_for_test(&json!({
        "toolName": "workspace.read_file",
        "summary": { "status": "error", "summary": "failed" }
    })));
    assert!(!successful_tool_result_for_test(&json!({
        "toolName": "workspace.read_file",
        "summary": { "truncated": true }
    })));
    assert!(!successful_tool_result_for_test(&json!({
        "status": "ok",
        "summary": { "structured": { "value": 1 } }
    })));
}

#[test]
fn thread_creation_persists_snapshot_and_fork_inherits_it() {
    let fixture = MemoryFixture::new("thread-snapshot");
    fixture.extract(
        "memory-source",
        "memory-turn",
        vec![ExtractedMemory {
            scope: MemoryScope::Workspace,
            content: "This workspace uses Rust.".to_string(),
        }],
    );
    let input = fixture.store.phase2_input().unwrap().unwrap();
    fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![SelectionAdd {
                    scope: MemoryScope::Workspace,
                    path: Some(fixture.workspace_path.clone()),
                    content: "This workspace uses Rust.".to_string(),
                }],
                update: Vec::new(),
                remove: Vec::new(),
            },
        )
        .unwrap();

    let thread_store =
        WorkspaceThreadStore::new(fixture.root.clone(), default_desktop_capability_policy());
    let operation = thread_store.begin_operation().unwrap();
    let rpc = operation.thread_log();
    let source = thread_record(
        "thread-source",
        "desktop",
        &fixture.workspace_path,
        "2026-07-28T00:00:00Z",
    );
    rpc.create_from_thread_record(&source).unwrap();
    let source_snapshot = rpc
        .get_thread_memory_snapshot("thread-source")
        .unwrap()
        .unwrap();
    assert!(source_snapshot.contains("This workspace uses Rust."));

    let mut fork = thread_record(
        "thread-fork",
        "fork",
        &fixture.workspace_path,
        "2026-07-28T00:01:00Z",
    );
    fork.parent_thread_id = Some("thread-source".to_string());
    rpc.fork_from_rollout("thread-source", &fork, None, false)
        .unwrap();
    assert_eq!(
        rpc.get_thread_memory_snapshot("thread-fork").unwrap(),
        Some(source_snapshot)
    );
    drop(operation);

    let hydrated = crate::agent::bridge::hydrate_native_agent_memory_snapshot_for_runtime(
        json!({
            "threadId": "thread-fork",
            "messages": [{ "role": "user", "content": "Continue." }]
        }),
        &thread_store,
    )
    .unwrap();
    assert_eq!(
        hydrated["longTermMemorySnapshot"],
        "## Workspace memory\n\n- This workspace uses Rust.\n\n"
    );
}

fn thread_record(
    thread_id: &str,
    source: &str,
    working_directory: &str,
    timestamp: &str,
) -> ThreadRecord {
    let mut metadata = ThreadMetadata::default();
    metadata.working_directory = Some(working_directory.to_string());
    ThreadRecord {
        thread_id: thread_id.to_string(),
        title: "New session".to_string(),
        status: ThreadStatus::Empty,
        session_key: Some(thread_id.to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: source.to_string(),
        created_at: timestamp.to_string(),
        updated_at: timestamp.to_string(),
        archived_at: None,
        metadata,
    }
}
