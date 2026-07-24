#[cfg(test)]
mod tests {
    use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
    use crate::protocol::WorkerRequest;
    use crate::rpc::WorkerRpcRouter;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn dispatches_memory_save_and_search_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "session_id": "session-1",
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff", "communication"],
                "metadata": { "source": "desktop" },
                "message_start": 3,
                "message_end": 4
            }),
        );

        let save_response = router.dispatch(&save_request);
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let search_request = WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.search",
            json!({
                "query": "handoff",
                "note_type": "preference",
                "status": "active",
                "limit": 5
            }),
        );

        let search_response = router.dispatch(&search_request);
        let mut expected_search_note = saved_note.clone();
        expected_search_note["file"] = json!("memory/notes.jsonl");
        expected_search_note["line"] = json!(1);
        expected_search_note["view_file"] = json!("USER.md");

        assert_eq!(saved_note["scope"], "user");
        assert_eq!(saved_note["type"], "preference");
        assert_eq!(saved_note["status"], "active");
        assert_eq!(
            saved_note["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(saved_note["priority"], 0.8);
        assert_eq!(saved_note["confidence"], 0.7);
        assert_eq!(saved_note["tags"], json!(["handoff", "communication"]));
        assert_eq!(saved_note["metadata"], json!({ "source": "desktop" }));
        assert_eq!(
            saved_note["sources"],
            json!([
                {
                    "capture_origin": "explicit",
                    "session_key": "session-1",
                    "message_start": 3,
                    "message_end": 4
                }
            ])
        );
        assert_eq!(
            search_response.result,
            Some(json!({ "notes": [expected_search_note] }))
        );
        assert!(save_response.error.is_none());
        assert!(search_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("User prefers concise implementation handoffs."));
    }

    #[test]
    fn memory_search_rejects_invalid_notes_jsonl_line() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\nnot-json\n",
                json!({
                    "id": "note-1",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers concise handoffs.",
                    "priority": 0.8,
                    "confidence": 0.7,
                    "sources": []
                })
            ),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-search",
            "trace-1",
            "memory.search",
            json!({ "query": "handoffs" }),
        ));

        let error = response
            .error
            .expect("invalid notes JSONL should fail the request");
        assert_eq!(
            error.code,
            crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "memory JSONL store failed");
        assert!(error.details["error"]
            .as_str()
            .unwrap_or_default()
            .contains("line 2"));
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_memory_recall_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let note_id = saved_note["id"]
            .as_str()
            .expect("saved note should have id");

        let recall_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.recall",
            json!({
                "query": "handoff",
                "max_notes": 6,
                "max_chars": 1600
            }),
        ));

        let result = recall_response
            .result
            .as_ref()
            .expect("memory.recall should return result");
        assert_eq!(recall_response.error, None);
        assert!(result["context"]
            .as_str()
            .expect("context should be a string")
            .contains("[MEMORY RECALL]"));
        assert_eq!(result["notes"][0]["id"], note_id);
        assert_eq!(result["references"][0]["note_id"], note_id);
        assert_eq!(
            result["references"][0]["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(result["references"][0]["view_file"], "USER.md");
    }

    #[test]
    fn dispatches_memory_dream_log_for_latest_git_memory_commit() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({}),
        ));
        let result = response.result.expect("dream log should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream log content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Update"));
        assert!(content.contains("Here is the latest Dream memory change."));
        assert!(content.contains("- Changed files: `memory/MEMORY.md`"));
        assert!(content.contains("Use `/dream-restore "));
        assert!(content.contains("```diff"));
        assert!(content.contains("+Dream captured a durable fact."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_lists_recent_commits() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore-list",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Restore"));
        assert!(content.contains("Choose a Dream memory version to restore. Latest first:"));
        assert!(content.contains("dream: 2026-06-12, 1 change(s)"));
        assert!(content.contains("Preview a version with `/dream-log <sha>` before restoring it."));
        assert!(content.contains("Restore a version with `/dream-restore <sha>`."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_reverts_selected_commit() {
        let fixture = dream_git_fixture();
        let sha = fixture.git_stdout(&["rev-parse", "--short=8", "HEAD"]);
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({ "sha": sha.trim() }),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("Restored Dream memory to the state before"));
        assert!(content.contains("- New safety commit: `"));
        assert!(content.contains("- Restored files: `memory/MEMORY.md`"));
        assert_eq!(fixture.read("memory/MEMORY.md"), "Initial memory\n");
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_run_reports_nothing_to_process_without_pending_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "Remember that I prefer workspace command policies.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(content
            .contains("Dream captured 1 memory note(s) from 1 conversation evidence record(s)."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["last_evidence_cursor"], json!(3));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "3");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\"]"));
        assert!(notes.contains("Remember that I prefer workspace command policies."));
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "User prefers concise progress updates."
                }),
                json!({
                    "cursor": 4,
                    "timestamp": "2026-06-12 03:01",
                    "content": "Short exchange with no durable memory."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(
            content.contains("Dream captured 1 memory note(s) from 2 legacy history record(s).")
        );
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(2));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(result["metadata"]["last_dream_cursor"], json!(4));
        assert_eq!(fixture.read("memory/.dream_cursor"), "4");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":3"));
        assert!(notes.contains("User prefers concise progress updates."));
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["skipped_evidence"], json!(1));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "We discussed the desktop runtime behavior."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(fixture.read("memory/.dream_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_pending_returns_deferred_conversation_evidence_batch() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "note_user_pref",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers compact migration slices.",
                    "priority": 0.8,
                    "confidence": 0.9,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/MEMORY.md", "Project memory view\n");
        fixture.write("SOUL.md", "Assistant memory view\n");
        fixture.write("USER.md", "User memory view\n");
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-pending",
            "trace-1",
            "memory.dream_pending",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream pending should return a batch");

        assert!(response.error.is_none());
        assert_eq!(result["kind"], json!("conversation_evidence"));
        assert_eq!(result["pending_evidence"], json!(1));
        assert_eq!(result["cursor_start"], json!(3));
        assert_eq!(result["cursor_end"], json!(3));
        assert_eq!(result["evidence_ids"], json!(["ev_1"]));
        assert_eq!(
            result["records"][0]["content"],
            json!("We discussed the desktop runtime behavior.")
        );
        assert!(result["memory_context"]["current_notes"]
            .as_str()
            .unwrap_or_default()
            .contains("id=note_user_pref status=active scope=user type=preference"));
        assert_eq!(
            result["memory_context"]["current_memory"],
            json!("Project memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_soul"],
            json!("Assistant memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_user"],
            json!("User memory view\n")
        );
    }

    #[test]
    fn memory_dream_pending_rejects_invalid_conversation_jsonl_line() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\nnot-json\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-pending",
            "trace-1",
            "memory.dream_pending",
            json!({}),
        ));

        let error = response
            .error
            .expect("invalid conversation JSONL should fail the request");
        assert_eq!(
            error.code,
            crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "memory JSONL store failed");
        assert!(error.details["error"]
            .as_str()
            .unwrap_or_default()
            .contains("line 2"));
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_memory_dream_apply_writes_provider_notes_with_dream_source_and_advances_cursor() {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "conversation_evidence",
                "session_id": "desktop:session-1",
                "cursor_start": 3,
                "cursor_end": 5,
                "evidence_ids": ["ev_1", "ev_2"],
                "notes": [{
                    "content": "User wants desktop runtime migration slices to stay reasonably sized.",
                    "note_type": "preference",
                    "scope": "user",
                    "priority": 0.7,
                    "confidence": 0.8,
                    "tags": ["migration"],
                    "metadata": { "source": "provider" }
                }]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(1));
        assert_eq!(result["last_evidence_cursor"], json!(5));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "5");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\",\"ev_2\"]"));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":5"));
        assert!(notes.contains("\"extractor\":\"ts_provider_dream\""));
        assert!(
            notes.contains("User wants desktop runtime migration slices to stay reasonably sized.")
        );
    }

    #[test]
    fn dispatches_memory_dream_apply_rejects_and_supersedes_provider_operations() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "id": "note_reject",
                    "scope": "project",
                    "type": "project",
                    "status": "active",
                    "content": "Temporary runtime discussion should be durable.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                }),
                json!({
                    "id": "note_old",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers very tiny migration commits.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "3");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "legacy_history",
                "cursor_start": 4,
                "cursor_end": 6,
                "notes": [
                    {
                        "action": "reject",
                        "target_note_id": "note_reject",
                        "metadata": { "reason": "provider correction" }
                    },
                    {
                        "action": "supersede",
                        "target_note_id": "note_old",
                        "content": "User prefers reasonably sized migration slices.",
                        "note_type": "preference",
                        "scope": "user",
                        "priority": 0.8,
                        "confidence": 0.9,
                        "tags": ["dream"]
                    }
                ]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(2));
        assert_eq!(result["last_dream_cursor"], json!(6));
        assert_eq!(fixture.read("memory/.dream_cursor"), "6");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"id\":\"note_reject\""));
        assert!(notes.contains("\"status\":\"rejected\""));
        assert!(notes.contains("\"id\":\"note_old\""));
        assert!(notes.contains("\"status\":\"superseded\""));
        assert!(notes.contains("\"supersedes\":[\"note_old\"]"));
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":4"));
        assert!(notes.contains("\"history_end_cursor\":6"));
        assert!(notes.contains("User prefers reasonably sized migration slices."));
    }

    #[test]
    fn dispatches_memory_dream_command_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let run_response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));
        let log_response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({ "sha": "abc123" }),
        ));
        let restore_response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));

        assert_eq!(
            run_response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert_eq!(
            log_response.result,
            Some(json!({
                "content": "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert_eq!(
            restore_response.result,
            Some(json!({
                "content": "Dream history is not available because memory versioning is not initialized.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert!(run_response.error.is_none());
        assert!(log_response.error.is_none());
        assert!(restore_response.error.is_none());
    }

    #[test]
    fn dispatches_memory_capture_evidence_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.capture_evidence",
            json!({
                "session_key": "desktop:session-1",
                "start_index": 7,
                "messages": [
                    { "role": "user", "content": "Remember this migration note.", "timestamp": "2026-06-12T03:00:00Z" },
                    { "role": "assistant", "content": "Captured.", "timestamp": "2026-06-12T03:00:01Z" },
                    { "role": "assistant", "content": "", "tool_calls": [{ "id": "call-1" }] },
                    { "role": "tool", "content": "ignored" }
                ]
            }),
        ));

        let result = response
            .result
            .as_ref()
            .expect("memory.capture_evidence should return result");
        assert_eq!(response.error, None);
        assert_eq!(result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(result["evidence"][0]["session_key"], "desktop:session-1");
        assert_eq!(result["evidence"][0]["role"], "user");
        assert_eq!(
            result["evidence"][0]["content"],
            "Remember this migration note."
        );
        assert_eq!(result["evidence"][0]["message_index"], 7);
        assert_eq!(result["evidence"][0]["cursor"], 1);
        assert_eq!(result["evidence"][1]["role"], "assistant");
        assert_eq!(result["evidence"][1]["message_index"], 8);
        assert_eq!(result["evidence"][1]["cursor"], 2);
        assert!(fixture
            .read("memory/conversations/2026-06-12.jsonl")
            .contains("Remember this migration note."));
        assert_eq!(fixture.read("memory/.evidence_sequence").trim(), "2");

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.list_evidence",
            json!({ "session_key": "desktop:session-1", "limit": 10 }),
        ));
        let list_result = list_response
            .result
            .as_ref()
            .expect("memory.list_evidence should return result");
        assert_eq!(list_response.error, None);
        assert_eq!(list_result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(list_result["evidence"][0]["cursor"], 1);
        assert_eq!(list_result["evidence"][1]["cursor"], 2);
    }

    #[test]
    fn dispatches_memory_trace_reject_and_supersede_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use npm test for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.6,
                "confidence": 0.65,
                "tags": ["testing"]
            }),
        ));
        let old_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let old_note_id = old_note["id"].as_str().expect("saved note should have id");

        let trace_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.trace",
            json!({ "note_id": old_note_id }),
        ));
        let supersede_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.supersede",
            json!({
                "note_id": old_note_id,
                "replacement_content": "Use vitest for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.8,
                "confidence": 0.9,
                "tags": ["testing", "typescript"],
                "metadata": { "reason": "TS worker tests run in Vitest" },
                "session_id": "session-1",
                "message_start": 5,
                "message_end": 6
            }),
        ));
        let replacement_id = supersede_response
            .result
            .as_ref()
            .expect("memory.supersede should return result")["note"]["id"]
            .as_str()
            .expect("replacement note should have id")
            .to_string();
        let reject_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "memory.reject",
            json!({ "note_id": replacement_id }),
        ));

        assert_eq!(
            trace_response.result.as_ref().unwrap()["note"]["id"],
            old_note_id
        );
        assert_eq!(
            trace_response.result.as_ref().unwrap()["locations"],
            json!({
                "file": "memory/notes.jsonl",
                "line": 1,
                "view_file": "SOUL.md"
            })
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["status"],
            "superseded"
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["superseded_by"],
            replacement_id
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["supersedes"],
            json!([old_note_id])
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["sources"],
            json!([{
                "capture_origin": "explicit",
                "session_key": "session-1",
                "message_start": 5,
                "message_end": 6
            }])
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["note"]["status"],
            "rejected"
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["views_refreshed"],
            true
        );
        assert!(trace_response.error.is_none());
        assert!(supersede_response.error.is_none());
        assert!(reject_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"superseded\""));
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"rejected\""));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use npm test for TS worker tests."));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use vitest for TS worker tests."));
    }

    #[test]
    fn dispatches_memory_rebuild_index_as_unavailable_noop() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );
        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.rebuild_index",
            json!({}),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "available": false,
                "rebuilt": false,
                "indexed": 0,
                "backend": null,
                "reason": "vector memory index is not available in the native runtime"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_refresh_views_from_canonical_notes() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-save",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        assert!(save_response.error.is_none());
        fixture.write(
            "USER.md",
            "# User Profile\n\nKeep this unmanaged note.\n\n## User Memory Notes\n\n(Stale managed content.)\n\n*Edit unmanaged sections for manual profile details.*\n",
        );

        let refresh_response = router.dispatch(&WorkerRequest::new(
            "req-refresh",
            "trace-1",
            "memory.refresh_views",
            json!({}),
        ));

        let user_view = fixture.read("USER.md");
        assert_eq!(
            refresh_response.result,
            Some(json!({
                "views_refreshed": true,
                "note_count": 1,
                "view_files": ["memory/MEMORY.md", "USER.md", "SOUL.md"]
            }))
        );
        assert!(refresh_response.error.is_none());
        assert!(user_view.contains("Keep this unmanaged note."));
        assert!(user_view.contains("### Preference"));
        assert!(user_view.contains("User prefers concise implementation handoffs."));
        assert!(!user_view.contains("Stale managed content"));
    }

    #[test]
    fn dispatches_memory_legacy_migration_without_rewriting_markdown_views() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/MEMORY.md",
            "# Memory\n\n- Project uses source-linked swarm wording.\n\nKeep maintainer docs separate.",
        );
        fixture.write("USER.md", "- User prefers uv commands.");
        fixture.write(
            "SOUL.md",
            "## Soul\n\nAvoid vendor API names in tinybot surfaces.",
        );
        let original_memory = fixture.read("memory/MEMORY.md");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let first_response = router.dispatch(&WorkerRequest::new(
            "req-migrate-1",
            "trace-1",
            "memory.migrate_legacy_notes",
            json!({}),
        ));
        let second_response = router.dispatch(&WorkerRequest::new(
            "req-migrate-2",
            "trace-1",
            "memory.migrate_legacy_notes",
            json!({}),
        ));
        let search_response = router.dispatch(&WorkerRequest::new(
            "req-search",
            "trace-1",
            "memory.search",
            json!({ "query": "legacy-migration", "limit": 10 }),
        ));

        let first_notes = first_response
            .result
            .as_ref()
            .expect("memory.migrate_legacy_notes should return result")["notes"]
            .as_array()
            .expect("migrated notes should be an array")
            .clone();
        let second_notes = second_response
            .result
            .as_ref()
            .expect("second memory.migrate_legacy_notes should return result")["notes"]
            .as_array()
            .expect("second migrated notes should be an array")
            .clone();
        let stored_notes = search_response
            .result
            .as_ref()
            .expect("memory.search should return result")["notes"]
            .as_array()
            .expect("stored notes should be an array")
            .clone();

        assert_eq!(first_notes.len(), 4);
        assert_eq!(second_notes.len(), 4);
        assert_eq!(stored_notes.len(), 4);
        assert_eq!(fixture.read("memory/MEMORY.md"), original_memory);
        assert!(first_notes
            .iter()
            .all(|note| note["priority"] == json!(0.4)));
        assert!(first_notes
            .iter()
            .all(|note| note["confidence"] == json!(0.45)));
        assert!(first_notes.iter().all(|note| note["status"] == "active"));
        assert!(first_notes
            .iter()
            .all(|note| note["tags"] == json!(["legacy-migration"])));
        assert_eq!(
            first_notes
                .iter()
                .map(|note| note["sources"][0]["source_file"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["memory/MEMORY.md", "USER.md", "SOUL.md"])
        );
        assert_eq!(
            first_notes
                .iter()
                .map(|note| note["id"].clone())
                .collect::<Vec<_>>(),
            second_notes
                .iter()
                .map(|note| note["id"].clone())
                .collect::<Vec<_>>()
        );
        assert!(first_response.error.is_none());
        assert!(second_response.error.is_none());
        assert!(search_response.error.is_none());
    }

    #[test]
    fn memory_search_respects_read_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.search",
            json!({ "query": "handoff" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "memory.read");
        assert!(response.result.is_none());
    }

    #[test]
    fn memory_save_refreshes_managed_memory_views() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "USER.md",
            "# User Profile\n\nKeep this unmanaged note.\n\n## User Memory Notes\n\n(Old managed content.)\n\n*Edit unmanaged sections for manual profile details.*\n",
        );
        fixture.write(
            "SOUL.md",
            "# Assistant Profile\n\n## Assistant Memory Notes\n\n(Old assistant managed content.)\n",
        );
        fixture.write(
            "memory/MEMORY.md",
            "# Long-term Memory\n\n## Project Memory Notes\n\n(Old project managed content.)\n",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let preference = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let instruction = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.save",
            json!({
                "content": "Speak directly and avoid vague claims.",
                "note_type": "instruction"
            }),
        ));
        let project = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use the TS worker for experimental agent turns.",
                "note_type": "decision"
            }),
        ));

        let user_view = fixture.read("USER.md");
        let soul_view = fixture.read("SOUL.md");
        let project_view = fixture.read("memory/MEMORY.md");

        assert!(preference.error.is_none());
        assert!(instruction.error.is_none());
        assert!(project.error.is_none());
        assert!(user_view.contains("# User Profile"));
        assert!(user_view.contains("Keep this unmanaged note."));
        assert!(user_view.contains("## User Memory Notes"));
        assert!(user_view.contains("### Preference"));
        assert!(user_view.contains("User prefers concise implementation handoffs."));
        assert!(user_view.contains("tags=handoff"));
        assert!(!user_view.contains("Old managed content"));
        assert!(soul_view.contains("## Assistant Memory Notes"));
        assert!(soul_view.contains("### Instruction"));
        assert!(soul_view.contains("Speak directly and avoid vague claims."));
        assert!(project_view.contains("## Project Memory Notes"));
        assert!(project_view.contains("### Decision"));
        assert!(project_view.contains("Use the TS worker for experimental agent turns."));
    }

    fn dream_git_fixture() -> WorkspaceFixture {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/MEMORY.md", "Initial memory\n");
        fixture.write("USER.md", "");
        fixture.write("SOUL.md", "");
        fixture.write("memory/notes.jsonl", "");
        fixture.git(&["init"]);
        fixture.git(&[
            "add",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "init: tinybot memory store",
        ]);
        fixture.write(
            "memory/MEMORY.md",
            "Initial memory\nDream captured a durable fact.\n",
        );
        fixture.git(&["add", "memory/MEMORY.md"]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "dream: 2026-06-12, 1 change(s)",
        ]);
        fixture
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let counter = WORKSPACE_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-memory-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos(),
                counter
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }

        fn read(&self, relative_path: &str) -> String {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::read_to_string(path).expect("fixture file should read")
        }

        fn git(&self, args: &[&str]) {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        }

        fn git_stdout(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
