use super::*;

#[test]
fn dispatches_thread_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-create",
        "trace-thread-create",
        "thread.create",
        json!({
            "title": "Reactbits research",
            "sessionKey": "session-1",
            "metadata": {
                "tags": ["ui", "agent"],
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .expect("thread id should be present")
        .to_string();

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-append",
        "trace-thread-append",
        "thread.append_items",
        json!({
            "threadId": thread_id,
            "items": [{
                "itemId": "",
                "threadId": "",
                "turnId": "turn-1",
                "sequence": 0,
                "createdAt": "",
                "kind": {
                    "type": "user_message",
                    "payload": { "text": "Summarize a document" }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);
    assert_eq!(append.result.as_ref().unwrap()["items"][0]["sequence"], 1);

    let search = router.dispatch(&WorkerRequest::new(
        "req-thread-search",
        "trace-thread-search",
        "thread.search",
        json!({ "query": "summarize" }),
    ));
    assert_eq!(search.error, None);
    assert_eq!(
        search.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-read",
        "trace-thread-read",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive",
        "trace-thread-archive",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

    let list = router.dispatch(&WorkerRequest::new(
        "req-thread-list",
        "trace-thread-list",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
}

#[test]
fn thread_list_does_not_merge_in_memory_session_metadata_at_request_time() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "session:websocket-1".to_string();
    legacy_session.title = "Legacy Websocket Session".to_string();
    legacy_session.updated_at = "2026-06-09T11:00:00Z".to_string();
    legacy_session.extra = json!({
        "mode": "desktop",
        "metadata": {
            "topic": "reactbits"
        },
        "messages": [
            {
                "role": "user",
                "content": "查看 reactbits 内容",
                "timestamp": "2026-06-09T10:58:00Z"
            },
            {
                "role": "assistant",
                "content": "整理 chat layout 文档",
                "timestamp": "2026-06-09T10:59:00Z"
            }
        ]
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session.clone()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-thread-list-legacy-session",
        "trace-thread-legacy-session",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());
}

#[test]
fn thread_api_survives_restart_from_rollout_without_legacy_stores() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    {
        let mut router =
            WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy.clone());
        let create = router.dispatch(&WorkerRequest::new(
            "req-rollout-thread-create",
            "trace-rollout-thread",
            "thread.create",
            json!({
                "threadId": "thread-rollout-restart",
                "title": "Rollout restart",
                "sessionKey": "session-rollout-restart"
            }),
        ));
        assert_eq!(create.error, None);
        let append = router.dispatch(&WorkerRequest::new(
            "req-rollout-thread-append",
            "trace-rollout-thread",
            "thread.append_items",
            json!({
                "threadId": "thread-rollout-restart",
                "items": [{
                    "itemId": "thread-rollout-restart:item:user",
                    "threadId": "",
                    "turnId": "turn-rollout-restart",
                    "sequence": 0,
                    "createdAt": "2026-07-18T00:00:00Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "persisted through rollout" }
                    }
                }]
            }),
        ));
        assert_eq!(append.error, None);
    }

    let mut restarted = WorkerRpcRouter::new(fixture.root.clone(), json!({}), vec![], 20, policy);
    let read = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-thread-read-after-restart",
        "trace-rollout-thread",
        "thread.read",
        json!({ "threadId": "thread-rollout-restart" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["sessionKey"],
        "session-rollout-restart"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "persisted through rollout"
    );
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_some());
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    assert_removed_persistence_paths_absent(&fixture.root);
}

#[test]
fn dispatches_thread_lifecycle_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-create",
        "trace-thread-lifecycle",
        "thread.create",
        json!({ "title": "Lifecycle" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-archive",
        "trace-thread-lifecycle",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");
    let archived_path = first_archived_thread_log_file(&fixture.root);
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());

    let resume = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-resume",
        "trace-thread-lifecycle",
        "thread.resume",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(resume.error, None);
    assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "empty");
    assert_eq!(resume.result.as_ref().unwrap()["activeTurn"], json!(null));
    assert!(!archived_path.exists());
    assert!(first_thread_log_file(&fixture.root).exists());

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-status",
        "trace-thread-lifecycle",
        "thread.status",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["thread"]["threadId"],
        thread_id
    );
    assert_eq!(status.result.as_ref().unwrap()["children"], json!([]));

    let rearchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-rearchive",
        "trace-thread-lifecycle",
        "thread.archive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(rearchive.error, None);
    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-unarchive",
        "trace-thread-lifecycle",
        "thread.unarchive",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

    let delete = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-delete",
        "trace-thread-lifecycle",
        "thread.delete",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(delete.error, None);
    assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

    let read_deleted = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-read-deleted",
        "trace-thread-lifecycle",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(
        read_deleted.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
}

#[test]
fn dispatches_thread_resume_from_checkpoint_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-create",
        "trace-thread-resume-checkpoint",
        "thread.create",
        json!({ "threadId": "thread-resume-checkpoint", "title": "Resume checkpoint" }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-append",
        "trace-thread-resume-checkpoint",
        "thread.append_items",
        json!({
            "threadId": "thread-resume-checkpoint",
            "items": [
                {
                    "itemId": "thread-resume-checkpoint-before",
                    "threadId": "",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "Before checkpoint" }
                    }
                },
                {
                    "itemId": "thread-resume-checkpoint-marker",
                    "threadId": "",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:02Z",
                    "kind": {
                        "type": "checkpoint_created",
                        "payload": {
                            "checkpointId": "checkpoint-resume",
                            "turnId": "turn-resume-checkpoint",
                            "restorePayload": { "phase": "awaiting_tool" }
                        }
                    }
                },
                {
                    "itemId": "thread-resume-checkpoint-after",
                    "threadId": "",
                    "turnId": "turn-resume-checkpoint",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:03Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "After checkpoint" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint-archive",
        "trace-thread-resume-checkpoint",
        "thread.archive",
        json!({ "threadId": "thread-resume-checkpoint" }),
    ));
    assert_eq!(archive.error, None);

    let resume = router.dispatch(&WorkerRequest::new(
        "req-thread-resume-checkpoint",
        "trace-thread-resume-checkpoint",
        "thread.resume",
        json!({
            "threadId": "thread-resume-checkpoint",
            "checkpointId": "checkpoint-resume"
        }),
    ));
    assert_eq!(resume.error, None);
    let items = resume.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["sequence"], 2);
    assert_eq!(items[0]["kind"]["type"], "checkpoint_created");
    assert_eq!(items[1]["sequence"], 3);
    assert_eq!(
        resume.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
        "checkpoint-resume"
    );
    assert_eq!(resume.result.as_ref().unwrap()["thread"]["status"], "idle");
}

#[test]
fn dispatches_thread_archive_children_policy() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-parent",
        "trace-thread-archive-tree",
        "thread.create",
        json!({
            "threadId": "thread-archive-tree-parent",
            "title": "Parent",
            "source": "agent_turn"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-child",
        "trace-thread-archive-tree",
        "thread.create",
        json!({
            "threadId": "thread-archive-tree-child",
            "title": "Child",
            "parentThreadId": "thread-archive-tree-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-archive",
        "trace-thread-archive-tree",
        "thread.archive",
        json!({
            "threadId": "thread-archive-tree-parent",
            "archiveChildren": true
        }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(archive.result.as_ref().unwrap()["status"], "archived");

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-children",
        "trace-thread-archive-tree",
        "thread.list",
        json!({
            "parentThreadId": "thread-archive-tree-parent",
            "includeArchived": true
        }),
    ));
    assert_eq!(children.error, None);
    assert_eq!(
        children.result.as_ref().unwrap()["threads"][0]["threadId"],
        "thread-archive-tree-child"
    );
    assert_eq!(
        children.result.as_ref().unwrap()["threads"][0]["status"],
        "archived"
    );

    let default_children = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-default-children",
        "trace-thread-archive-tree",
        "thread.list",
        json!({ "parentThreadId": "thread-archive-tree-parent" }),
    ));
    assert_eq!(default_children.error, None);
    assert_eq!(
        default_children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-unarchive",
        "trace-thread-archive-tree",
        "thread.unarchive",
        json!({
            "threadId": "thread-archive-tree-parent",
            "unarchiveChildren": true
        }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(unarchive.result.as_ref().unwrap()["status"], "empty");

    let unarchived_child = router.dispatch(&WorkerRequest::new(
        "req-thread-archive-tree-read-unarchived-child",
        "trace-thread-archive-tree",
        "thread.read",
        json!({ "threadId": "thread-archive-tree-child" }),
    ));
    assert_eq!(unarchived_child.error, None);
    assert_eq!(
        unarchived_child.result.as_ref().unwrap()["thread"]["status"],
        "empty"
    );
}

#[test]
fn dispatches_thread_fork_include_children_policy() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-parent",
        "trace-thread-fork-tree",
        "thread.create",
        json!({
            "threadId": "thread-fork-tree-parent",
            "title": "Fork parent",
            "source": "agent_turn"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child",
        "trace-thread-fork-tree",
        "thread.create",
        json!({
            "threadId": "thread-fork-tree-child",
            "title": "Fork child",
            "parentThreadId": "thread-fork-tree-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);
    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child-append",
        "trace-thread-fork-tree",
        "thread.append_items",
        json!({
            "threadId": "thread-fork-tree-child",
            "items": [{
                "itemId": "thread-fork-tree-child-item",
                "threadId": "",
                "turnId": "turn-fork-child",
                "sequence": 0,
                "createdAt": "2026-07-05T00:00:01Z",
                "kind": {
                    "type": "user_message",
                    "payload": { "text": "Child context" }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-fork",
        "trace-thread-fork-tree",
        "thread.fork",
        json!({
            "threadId": "thread-fork-tree-parent",
            "title": "Forked parent",
            "includeChildren": true
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-children",
        "trace-thread-fork-tree",
        "thread.list",
        json!({ "parentThreadId": fork_thread_id }),
    ));
    assert_eq!(children.error, None);
    let child_threads = children.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap();
    assert_eq!(child_threads.len(), 1);
    assert_eq!(child_threads[0]["title"], "Fork child");
    assert_eq!(child_threads[0]["parentThreadId"], fork_thread_id);
    let copied_child_thread_id = child_threads[0]["threadId"].as_str().unwrap();
    assert_ne!(copied_child_thread_id, "thread-fork-tree-child");

    let copied_child = router.dispatch(&WorkerRequest::new(
        "req-thread-fork-tree-child-read",
        "trace-thread-fork-tree",
        "thread.read",
        json!({ "threadId": copied_child_thread_id }),
    ));
    assert_eq!(copied_child.error, None);
    assert_eq!(
        copied_child.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "Child context"
    );
}

#[test]
fn dispatches_thread_fork_idempotently_by_client_event_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-create",
        "trace-thread-direct-fork-idempotent",
        "thread.create",
        json!({ "threadId": "thread-direct-fork-source", "title": "Fork source" }),
    ));
    assert_eq!(create.error, None);

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-fork",
        "trace-thread-direct-fork-idempotent",
        "thread.fork",
        json!({
            "threadId": "thread-direct-fork-source",
            "clientEventId": "direct-fork-client-1",
            "title": "Direct fork"
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(fork.result.as_ref().unwrap()["title"], "Direct fork");

    let fork_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-fork-retry",
        "trace-thread-direct-fork-idempotent",
        "thread.fork",
        json!({
            "threadId": "thread-direct-fork-source",
            "clientEventId": "direct-fork-client-1",
            "title": "Retry must not fork"
        }),
    ));
    assert_eq!(fork_retry.error, None);
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["threadId"],
        fork_thread_id
    );
    assert_eq!(fork_retry.result.as_ref().unwrap()["title"], "Direct fork");

    let children = router.dispatch(&WorkerRequest::new(
        "req-thread-direct-fork-idempotent-children",
        "trace-thread-direct-fork-idempotent",
        "thread.list",
        json!({ "parentThreadId": "thread-direct-fork-source", "includeChildThreads": true }),
    ));
    assert_eq!(children.error, None);
    let child_threads = children.result.as_ref().unwrap()["threads"]
        .as_array()
        .unwrap();
    assert_eq!(child_threads.len(), 1);
    assert_eq!(child_threads[0]["threadId"], fork_thread_id);
    assert_eq!(child_threads[0]["source"], "fork");
}

#[test]
fn thread_fork_inherits_effective_history_from_canonical_rollout() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .unwrap();
    let create = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-create",
        "trace-rollout-fork",
        "thread.create",
        json!({
            "threadId": "thread-rollout-fork-source",
            "title": "Canonical fork source"
        }),
    ));
    assert_eq!(create.error, None);
    for (turn_id, content) in [
        ("turn-rollout-fork-1", "keep"),
        ("turn-rollout-fork-2", "drop"),
    ] {
        let persist = router.dispatch(&WorkerRequest::new(
            format!("req-rollout-fork-{turn_id}"),
            "trace-rollout-fork",
            "session.persist_turn",
            json!({
                "session_id": "thread-rollout-fork-source",
                "turn_id": turn_id,
                "messages": [
                    { "role": "user", "content": format!("{content} user") },
                    { "role": "assistant", "content": format!("{content} assistant") }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let rollback = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-rollback",
        "trace-rollout-fork",
        "thread.rollback",
        json!({
            "threadId": "thread-rollout-fork-source",
            "numTurns": 1
        }),
    ));
    assert_eq!(rollback.error, None);

    let source = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-source-read",
        "trace-rollout-fork",
        "thread.read",
        json!({
            "threadId": "thread-rollout-fork-source",
            "limit": 80
        }),
    ));
    assert_eq!(source.error, None);
    let fork_after_sequence = source.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item["kind"]["type"] == "assistant_message_completed"
                && item["kind"]["payload"]["content"] == "keep assistant"
        })
        .unwrap()["sequence"]
        .as_u64()
        .unwrap();

    let fork = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork",
        "trace-rollout-fork",
        "thread.fork",
        json!({
            "threadId": "thread-rollout-fork-source",
            "title": "Canonical fork",
            "forkAfterSequence": fork_after_sequence
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_thread_id = fork.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(fork.result.as_ref().unwrap()["sessionKey"], fork_thread_id);

    let history = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-history",
        "trace-rollout-fork",
        "session.get_history",
        json!({ "session_id": fork_thread_id, "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    let contents = history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(contents, vec!["keep user", "keep assistant"]);

    let turns = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-turns",
        "trace-rollout-fork",
        "thread.turn.list",
        json!({ "sessionId": fork_thread_id }),
    ));
    assert_eq!(turns.error, None);
    assert!(turns.result.as_ref().unwrap()["turns"]
        .as_array()
        .unwrap()
        .is_empty());

    let rename = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-rename",
        "trace-rollout-fork",
        "thread.update_metadata",
        json!({
            "threadId": fork_thread_id,
            "metadata": { "title": "Durable fork title" }
        }),
    ));
    assert_eq!(rename.error, None);
    drop(router);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .unwrap();
    let reloaded = router.dispatch(&WorkerRequest::new(
        "req-rollout-fork-reloaded",
        "trace-rollout-fork",
        "thread.read",
        json!({ "threadId": fork_thread_id, "limit": 80 }),
    ));
    assert_eq!(reloaded.error, None);
    assert_eq!(
        reloaded.result.as_ref().unwrap()["thread"]["title"],
        "Durable fork title"
    );
}

#[test]
fn dispatches_thread_runtime_turn_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-create",
        "trace-thread-runtime",
        "thread.create",
        json!({ "title": "Runtime" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-start",
        "trace-thread-runtime",
        "thread.start_turn",
        json!({
            "threadId": thread_id,
            "turnId": "turn-runtime-1",
            "input": { "text": "Summarize this document" },
            "model": "deepseek-v4-flash",
            "provider": "tinybot"
        }),
    ));
    assert_eq!(start.error, None);
    let start_result = start.result.as_ref().unwrap();
    assert_eq!(start_result["turn"]["turnId"], "turn-runtime-1");
    assert_eq!(start_result["turn"]["status"], "running");
    assert_eq!(start_result["turn"]["active"], true);
    assert_eq!(
        start_result["appendedItems"]
            .as_array()
            .expect("start should append items")
            .len(),
        2
    );
    assert_eq!(start_result["snapshot"]["thread"]["status"], "running");

    let continue_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-continue",
        "trace-thread-runtime",
        "thread.continue_turn",
        json!({
            "threadId": thread_id,
            "input": { "approval": "continue" }
        }),
    ));
    assert_eq!(continue_turn.error, None);
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-runtime-1"
    );
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );

    let status_running = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-status-running",
        "trace-thread-runtime",
        "thread.status",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(status_running.error, None);
    assert_eq!(
        status_running.result.as_ref().unwrap()["activeTurn"]["turnId"],
        "turn-runtime-1"
    );

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-interrupt",
        "trace-thread-runtime",
        "thread.interrupt",
        json!({
            "threadId": thread_id,
            "reason": "user requested stop"
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "cancelled"
    );
    assert_eq!(interrupt.result.as_ref().unwrap()["turn"]["active"], false);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-read",
        "trace-thread-runtime",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["items"]
            .as_array()
            .expect("runtime items should be readable")
            .len(),
        4
    );
    assert_eq!(read.result.as_ref().unwrap()["activeTurn"], json!(null));
}

#[test]
fn dispatches_thread_runtime_turn_requests_idempotently() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-create",
        "trace-thread-runtime-idempotent",
        "thread.create",
        json!({ "threadId": "thread-runtime-idempotent", "title": "Runtime idempotency" }),
    ));
    assert_eq!(create.error, None);

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-start",
        "trace-thread-runtime-idempotent",
        "thread.start_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-start-client-1",
            "turnId": "turn-direct-original",
            "input": { "text": "Original prompt" },
            "model": "deepseek-v4-flash",
            "provider": "tinybot"
        }),
    ));
    assert_eq!(start.error, None);
    let start_items = start.result.as_ref().unwrap()["appendedItems"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        start.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-direct-original"
    );

    let start_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-start-retry",
        "trace-thread-runtime-idempotent",
        "thread.start_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-start-client-1",
            "turnId": "turn-direct-retry",
            "input": { "text": "Retry must not append" },
            "model": "retry-model",
            "provider": "retry-provider"
        }),
    ));
    assert_eq!(start_retry.error, None);
    assert_eq!(
        start_retry.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-direct-original"
    );
    assert_eq!(
        start_retry.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap(),
        &start_items
    );
    assert_eq!(
        start_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["text"],
        "Original prompt"
    );

    let continue_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-continue",
        "trace-thread-runtime-idempotent",
        "thread.continue_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-continue-client-1",
            "input": { "approval": "continue" }
        }),
    ));
    assert_eq!(continue_turn.error, None);
    let continue_items = continue_turn.result.as_ref().unwrap()["appendedItems"]
        .as_array()
        .unwrap()
        .clone();

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-interrupt",
        "trace-thread-runtime-idempotent",
        "thread.interrupt",
        json!({
            "threadId": "thread-runtime-idempotent",
            "reason": "stop before retry"
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );

    let continue_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-continue-retry",
        "trace-thread-runtime-idempotent",
        "thread.continue_turn",
        json!({
            "threadId": "thread-runtime-idempotent",
            "clientEventId": "direct-continue-client-1",
            "input": { "approval": "retry must replay" }
        }),
    ));
    assert_eq!(continue_retry.error, None);
    assert_eq!(
        continue_retry.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-direct-original"
    );
    assert_eq!(
        continue_retry.result.as_ref().unwrap()["appendedItems"]
            .as_array()
            .unwrap(),
        &continue_items
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-runtime-idempotent-read",
        "trace-thread-runtime-idempotent",
        "thread.read",
        json!({ "threadId": "thread-runtime-idempotent" }),
    ));
    assert_eq!(read.error, None);
    let items = read.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["kind"]["payload"]["text"], "Original prompt");
    assert_eq!(items[1]["kind"]["type"], "turn_started");
    assert_eq!(items[2]["kind"]["type"], "event");
    assert_eq!(items[3]["kind"]["type"], "cancelled");
}

#[test]
fn dispatches_thread_events_after_cursor() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-events-create",
        "trace-thread-events",
        "thread.create",
        json!({ "title": "Event feed" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-events-start",
        "trace-thread-events",
        "thread.start_turn",
        json!({
            "threadId": thread_id,
            "turnId": "turn-events-1",
            "input": "Summarize a document"
        }),
    ));
    assert_eq!(start.error, None);

    let first_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-first-page",
        "trace-thread-events",
        "thread.events",
        json!({ "threadId": thread_id, "afterSequence": 0, "limit": 1 }),
    ));
    assert_eq!(first_page.error, None);
    assert_eq!(first_page.result.as_ref().unwrap()["threadId"], thread_id);
    assert_eq!(
        first_page.result.as_ref().unwrap()["thread"]["threadId"],
        thread_id
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["thread"]["status"],
        "running"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["activeTurn"]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["turns"][0]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["turns"][0]["active"],
        true
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["items"][0]["sequence"],
        1
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
        "user_message"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["thread"]["threadId"],
        thread_id
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][0]["activeTurn"]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["thread"]["status"],
        "running"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][1]["activeTurn"]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["type"],
        "item_appended"
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["sequence"],
        1
    );
    assert_eq!(
        first_page.result.as_ref().unwrap()["events"][2]["item"]["kind"]["type"],
        "user_message"
    );
    assert_eq!(first_page.result.as_ref().unwrap()["nextCursor"], "1");

    let second_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-second-page",
        "trace-thread-events",
        "thread.events",
        json!({
            "threadId": thread_id,
            "cursor": first_page.result.as_ref().unwrap()["nextCursor"],
            "limit": 10
        }),
    ));
    assert_eq!(second_page.error, None);
    assert_eq!(
        second_page.result.as_ref().unwrap()["items"][0]["sequence"],
        2
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["items"][0]["kind"]["type"],
        "turn_started"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][0]["activeTurn"]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][2]["type"],
        "item_appended"
    );
    assert_eq!(
        second_page.result.as_ref().unwrap()["events"][2]["sequence"],
        2
    );
    assert_eq!(second_page.result.as_ref().unwrap()["nextCursor"], "2");

    let empty_page = router.dispatch(&WorkerRequest::new(
        "req-thread-events-empty-page",
        "trace-thread-events",
        "thread.events",
        json!({ "threadId": thread_id, "cursor": "2", "limit": 10 }),
    ));
    assert_eq!(empty_page.error, None);
    assert_eq!(
        empty_page.result.as_ref().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][0]["type"],
        "thread_snapshot"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][0]["activeTurn"]["turnId"],
        "turn-events-1"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][1]["type"],
        "thread_status"
    );
    assert_eq!(
        empty_page.result.as_ref().unwrap()["events"][1]["thread"]["threadId"],
        thread_id
    );
    assert_eq!(empty_page.result.as_ref().unwrap()["nextCursor"], "2");
}

#[test]
fn dispatches_tool_registry_list_with_capability_metadata() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::McpCall]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-list",
        "trace-tool-registry",
        "tool_registry.list",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    let tools = result["tools"]
        .as_array()
        .expect("tools should be an array");
    assert!(tools.len() >= 8);
    assert_eq!(result["total"], tools.len());

    let shell = tools
        .iter()
        .find(|tool| tool["method"] == "shell.execute")
        .expect("shell.execute should be registered");
    assert_eq!(shell["namespace"], "shell");
    assert_eq!(shell["exposure"], "hidden");
    assert_eq!(shell["available"], false);
    assert_eq!(shell["requiredCapabilities"], json!(["shell.execute"]));
    assert_eq!(shell["approval"]["required"], true);
    assert_eq!(shell["approval"]["scope"], "command");

    let mcp = tools
        .iter()
        .find(|tool| tool["method"] == "mcp.call_tool")
        .expect("mcp.call_tool should be registered");
    assert_eq!(mcp["namespace"], "mcp");
    assert_eq!(mcp["dynamic"], true);
    assert_eq!(mcp["requiredCapabilities"], json!(["mcp.call"]));

    let write_file = tools
        .iter()
        .find(|tool| tool["method"] == "workspace.write_file")
        .expect("workspace.write_file should be registered");
    assert_eq!(
        write_file["requiredCapabilities"],
        json!(["fs.workspace.write", "approval.request"])
    );
    assert_eq!(write_file["approval"]["required"], true);
    assert_eq!(write_file["available"], false);
}

#[test]
fn dispatches_tool_registry_search_with_filters() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::ShellExecute]),
    );

    let shell = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-shell",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({ "query": "command" }),
    ));
    assert_eq!(shell.error, None);
    assert_eq!(shell.result.as_ref().unwrap()["query"], "command");
    let shell_tools = shell.result.as_ref().unwrap()["tools"]
        .as_array()
        .expect("command search should return shell tools");
    assert_eq!(shell.result.as_ref().unwrap()["total"], 2);
    assert!(shell_tools
        .iter()
        .any(|tool| tool["method"] == "shell.execute" && tool["available"] == true));
    assert!(shell_tools
        .iter()
        .any(|tool| tool["method"] == "exec_command" && tool["available"] == true));

    let memory = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-memory",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({
            "namespace": "memory",
            "availableOnly": true,
            "exposure": "deferred"
        }),
    ));
    assert_eq!(memory.error, None);
    let memory_tools = memory.result.as_ref().unwrap()["tools"]
        .as_array()
        .expect("memory tools should be an array");
    assert_eq!(memory_tools.len(), 2);
    assert!(memory_tools
        .iter()
        .all(|tool| tool["namespace"] == "memory"));
    assert!(memory_tools.iter().all(|tool| tool["available"] == true));

    let unavailable = router.dispatch(&WorkerRequest::new(
        "req-tool-registry-search-unavailable",
        "trace-tool-registry-search",
        "tool_registry.search",
        json!({
            "namespace": "workspace",
            "availableOnly": true
        }),
    ));
    assert_eq!(unavailable.error, None);
    assert_eq!(unavailable.result.as_ref().unwrap()["total"], 0);
    assert!(unavailable.result.as_ref().unwrap()["tools"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn dispatches_permission_profile_current_with_tool_decisions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::FsWorkspaceRead,
            WorkerCapability::FsWorkspaceWrite,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::MemoryRead,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-current",
        "trace-permission-profile",
        "permission_profile.current",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["profileId"], "local-worker");
    assert_eq!(result["approvalPolicy"], "on_request");
    assert_eq!(result["sandbox"]["mode"], "workspace_write");
    assert!(result["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|capability| capability["capability"] == "fs.workspace.read"
            && capability["granted"] == true
            && capability["scope"] == "workspace://current"));
    assert!(result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["toolId"] != "workspace.read_file"));
    let memory_search = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "memory.search")
        .expect("memory.search decision should be present");
    assert_eq!(memory_search["decision"], "allow");
    assert_eq!(memory_search["requiresApproval"], false);
    let write_file = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "workspace.write_file")
        .expect("workspace.write_file decision should be present");
    assert_eq!(write_file["decision"], "needs_approval");
    assert_eq!(write_file["requiresApproval"], true);
    assert_eq!(write_file["approval"]["scope"], "file");
    let shell = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["toolId"] == "shell.execute")
        .expect("shell.execute decision should be present");
    assert_eq!(shell["decision"], "deny");
    assert_eq!(shell["missingCapabilities"], json!(["shell.execute"]));
}

#[test]
fn dispatches_permission_profile_evaluate_tool_for_sensitive_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
        ]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-evaluate-shell",
        "trace-permission-profile",
        "permission_profile.evaluate_tool",
        json!({
            "toolId": "shell.execute",
            "arguments": { "command": "cargo test --lib" },
            "sessionId": "session-1",
            "turnId": "turn-1"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["tool"]["toolId"], "shell.execute");
    assert_eq!(result["decision"], "needs_approval");
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["approvalRequest"]["method"], "shell.execute");
    assert_eq!(result["approvalRequest"]["category"], "shell");
    assert_eq!(result["approvalRequest"]["risk"], "high");
    assert_eq!(
        result["approvalRequest"]["operation"]["toolName"],
        "shell.execute"
    );
    assert_eq!(
        result["approvalRequest"]["operation"]["arguments"],
        json!({ "command": "cargo test --lib" })
    );
    assert_eq!(
        result["approvalRequest"]["operation"]["effects"],
        result["approvalRequest"]["effects"]
    );
    assert_eq!(
        result["approvalRequest"]["effects"]["sandboxMode"],
        "unsandboxed"
    );
    assert_eq!(
        result["approvalRequest"]["effects"]["network"]["mode"],
        "unrestricted"
    );
    assert_eq!(result["approvalRequest"]["sessionId"], "session-1");
    assert_eq!(result["approvalRequest"]["turnId"], "turn-1");
}

#[test]
fn dispatches_permission_profile_evaluate_tool_denies_missing_capability() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-profile-evaluate-denied",
        "trace-permission-profile",
        "permission_profile.evaluate_tool",
        json!({
            "toolId": "mcp.call_tool",
            "arguments": { "server": "docs", "tool": "search" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["tool"]["toolId"], "mcp.call_tool");
    assert_eq!(result["decision"], "deny");
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["missingCapabilities"], json!(["mcp.call"]));
    assert!(result.get("approvalRequest").is_none());
}

#[test]
fn dispatches_permission_profile_request_tool_approval_records_thread_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-create",
        "trace-permission-approval",
        "thread.create",
        json!({
            "threadId": "thread-permission-approval",
            "title": "Permission approval thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-start",
        "trace-permission-approval",
        "thread.start_turn",
        json!({
            "threadId": "thread-permission-approval",
            "turnId": "turn-permission-approval",
            "input": { "content": "run shell" }
        }),
    ));
    assert_eq!(start.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-request",
        "trace-permission-approval",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "threadId": "thread-permission-approval",
            "turnId": "turn-permission-approval",
            "sessionId": "session-permission-approval",
            "arguments": { "command": "echo needs approval" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["status"], "awaiting_approval");
    assert_eq!(result["evaluation"]["decision"], "needs_approval");
    assert_eq!(result["approval"]["stopReason"], "awaiting_approval");
    assert_eq!(result["approval"]["category"], "shell");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "approval_requested"
    );
    assert_eq!(
        result["appendedItems"][0]["kind"]["payload"]["approvalId"],
        result["approval"]["approvalId"]
    );

    let snapshot = router.dispatch(&WorkerRequest::new(
        "req-permission-approval-thread-snapshot",
        "trace-permission-approval",
        "thread.read",
        json!({ "threadId": "thread-permission-approval" }),
    ));
    assert_eq!(snapshot.error, None);
    let item_kinds = snapshot.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec!["user_message", "turn_started", "approval_requested"]
    );
}

#[test]
fn dispatches_permission_profile_resolve_tool_approval_records_thread_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-thread-create",
        "trace-permission-resolve",
        "thread.create",
        json!({
            "threadId": "thread-permission-resolve",
            "title": "Permission resolve thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-thread-start",
        "trace-permission-resolve",
        "thread.start_turn",
        json!({
            "threadId": "thread-permission-resolve",
            "turnId": "turn-permission-resolve",
            "input": { "content": "run shell" }
        }),
    ));
    assert_eq!(start.error, None);
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-request",
        "trace-permission-resolve",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "threadId": "thread-permission-resolve",
            "turnId": "turn-permission-resolve",
            "sessionId": "session-permission-resolve",
            "arguments": { "command": "echo resolve approval" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();

    let response = router.dispatch(&WorkerRequest::new(
        "req-permission-resolve-decision",
        "trace-permission-resolve",
        "permission_profile.resolve_tool_approval",
        json!({
            "threadId": "thread-permission-resolve",
            "turnId": "turn-permission-resolve",
            "sessionId": "session-permission-resolve",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once",
            "guidance": "approved for this turn"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["status"], "approved");
    assert_eq!(result["resolution"]["status"], "approved");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "approval_resolved"
    );
    assert_eq!(
        result["appendedItems"][0]["kind"]["payload"]["approved"],
        true
    );
    assert_eq!(
        result["appendedItems"][0]["parentItemId"],
        request_response.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
    );
}

#[test]
fn permission_profile_resolved_tool_approval_allows_matching_sensitive_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
        ]),
    );
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-request",
        "trace-permission-grant",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "turnId": "turn-permission-grant",
            "sessionId": "session-permission-grant",
            "arguments": { "command": "echo approval grant works" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-resolve",
        "trace-permission-grant",
        "permission_profile.resolve_tool_approval",
        json!({
            "sessionId": "session-permission-grant",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert_eq!(resolve_response.error, None);

    let shell_response = router.dispatch(&WorkerRequest::new(
        "req-permission-grant-shell",
        "trace-permission-grant",
        "shell.execute",
        json!({
            "command": "echo approval grant works",
            "working_dir": ".",
            "timeout": 5,
            "session_id": "session-permission-grant",
            "turn_id": "turn-permission-grant"
        }),
    ));

    assert_eq!(shell_response.error, None);
    let result = shell_response.result.as_ref().unwrap();
    assert_eq!(result["exit_code"], 0);
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("approval grant works"));
}

#[test]
fn tool_executor_forwards_top_level_context_to_sensitive_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::ShellExecute,
            WorkerCapability::ApprovalRequest,
            WorkerCapability::ApprovalResolve,
        ]),
    );
    let request_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-request",
        "trace-executor-grant",
        "permission_profile.request_tool_approval",
        json!({
            "toolId": "shell.execute",
            "turnId": "turn-executor-grant",
            "sessionId": "session-executor-grant",
            "arguments": { "command": "echo executor grant works" }
        }),
    ));
    assert_eq!(request_response.error, None);
    let approval_id = request_response.result.as_ref().unwrap()["approval"]["approvalId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-resolve",
        "trace-executor-grant",
        "permission_profile.resolve_tool_approval",
        json!({
            "sessionId": "session-executor-grant",
            "approvalId": approval_id,
            "approved": true,
            "scope": "once"
        }),
    ));
    assert_eq!(resolve_response.error, None);

    let executor_response = router.dispatch(&WorkerRequest::new(
        "req-executor-grant-shell",
        "trace-executor-grant",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "sessionId": "session-executor-grant",
            "turnId": "turn-executor-grant",
            "arguments": {
                "command": "echo executor grant works",
                "working_dir": ".",
                "timeout": 5
            }
        }),
    ));

    assert_eq!(executor_response.error, None);
    let result = executor_response.result.as_ref().unwrap();
    assert_eq!(result["result"]["exit_code"], 0);
    assert!(result["result"]["content"]
        .as_str()
        .unwrap()
        .contains("executor grant works"));
}

#[test]
fn dispatches_thread_restore_checkpoint_from_thread_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-create",
        "trace-thread-restore",
        "thread.create",
        json!({
            "threadId": "thread-restore-checkpoint",
            "title": "Restore checkpoint thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-start",
        "trace-thread-restore",
        "thread.start_turn",
        json!({
            "threadId": "thread-restore-checkpoint",
            "turnId": "turn-restore-checkpoint",
            "input": { "content": "prepare checkpoint" }
        }),
    ));
    assert_eq!(start.error, None);
    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-checkpoint",
        "trace-thread-restore",
        "thread.apply_op",
        json!({
            "threadId": "thread-restore-checkpoint",
            "op": {
                "type": "checkpoint",
                "turnId": "turn-restore-checkpoint",
                "checkpointId": "checkpoint-restore-1",
                "label": "Before tool execution",
                "restorePayload": {
                    "phase": "before_tool",
                    "pendingToolCalls": [{ "id": "call-1", "name": "workspace.read_file" }]
                }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    let after_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-after-checkpoint",
        "trace-thread-restore",
        "thread.apply_op",
        json!({
            "threadId": "thread-restore-checkpoint",
            "op": {
                "type": "runtime_event",
                "turnId": "turn-restore-checkpoint",
                "eventName": "agent.after_checkpoint",
                "source": "test",
                "visibility": "internal",
                "payload": { "after": true }
            }
        }),
    ));
    assert_eq!(after_checkpoint.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-restore",
        "trace-thread-restore",
        "thread.restore_checkpoint",
        json!({
            "threadId": "thread-restore-checkpoint",
            "checkpointId": "checkpoint-restore-1"
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["checkpoint"]["checkpointId"], "checkpoint-restore-1");
    assert_eq!(result["checkpoint"]["label"], "Before tool execution");
    assert_eq!(result["restorePayload"]["phase"], "before_tool");
    assert_eq!(
        result["restorePayload"]["pendingToolCalls"][0]["name"],
        "workspace.read_file"
    );
    assert_eq!(
        result["snapshot"]["items"][0]["kind"]["type"],
        "checkpoint_created"
    );
    assert_eq!(result["snapshot"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["snapshot"]["items"][1]["kind"]["payload"]["eventName"],
        "agent.after_checkpoint"
    );
}

#[test]
fn dispatches_thread_restore_checkpoint_defaults_to_latest_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest-create",
        "trace-thread-restore-latest",
        "thread.create",
        json!({ "threadId": "thread-restore-latest" }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest-start",
        "trace-thread-restore-latest",
        "thread.start_turn",
        json!({
            "threadId": "thread-restore-latest",
            "turnId": "turn-restore-latest",
            "input": { "content": "make checkpoints" }
        }),
    ));
    assert_eq!(start.error, None);
    for (checkpoint_id, phase) in [
        ("checkpoint-restore-old", "old"),
        ("checkpoint-restore-new", "new"),
    ] {
        let response = router.dispatch(&WorkerRequest::new(
            format!("req-thread-restore-latest-{phase}"),
            "trace-thread-restore-latest",
            "thread.apply_op",
            json!({
                "threadId": "thread-restore-latest",
                "op": {
                    "type": "checkpoint",
                    "turnId": "turn-restore-latest",
                    "checkpointId": checkpoint_id,
                    "restorePayload": { "phase": phase }
                }
            }),
        ));
        assert_eq!(response.error, None);
    }

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-restore-latest",
        "trace-thread-restore-latest",
        "thread.restore_checkpoint",
        json!({ "threadId": "thread-restore-latest" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(
        result["checkpoint"]["checkpointId"],
        "checkpoint-restore-new"
    );
    assert_eq!(result["restorePayload"]["phase"], "new");
    assert_eq!(
        result["snapshot"]["latestCheckpoint"]["checkpointId"],
        "checkpoint-restore-new"
    );
}

#[test]
fn dispatches_thread_agent_registry_for_parent_and_child_threads() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-parent",
        "trace-thread-agent-registry",
        "thread.create",
        json!({
            "threadId": "thread-agent-parent",
            "title": "Main thread",
            "sessionKey": "session-agent-registry",
            "source": "agent_turn"
        }),
    ));
    assert_eq!(parent.error, None);
    let parent_start = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-parent-start",
        "trace-thread-agent-registry",
        "thread.start_turn",
        json!({
            "threadId": "thread-agent-parent",
            "turnId": "turn-agent-parent",
            "input": { "content": "coordinate child work" }
        }),
    ));
    assert_eq!(parent_start.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child",
        "trace-thread-agent-registry",
        "thread.create",
        json!({
            "threadId": "thread-agent-child",
            "title": "Research child",
            "sessionKey": "session-agent-registry",
            "parentThreadId": "thread-agent-parent",
            "source": "subagent",
            "metadata": {
                "extra": {
                    "agentControl": {
                        "agentId": "child-agent-1",
                        "agentPath": ["main", "child-agent-1"],
                        "parentThreadId": "thread-agent-parent",
                        "parentTurnId": "turn-agent-parent",
                        "childTurnId": "turn-agent-child",
                        "role": "research",
                        "nickname": "Researcher",
                        "depth": 1,
                        "capacity": { "maxActivePerSession": 4 },
                        "lifecycle": {
                            "status": "awaiting_approval",
                            "active": true,
                            "terminal": false,
                            "mailboxDepth": 2,
                            "pendingApproval": { "approvalId": "approval-child-1" }
                        }
                    }
                }
            }
        }),
    ));
    assert_eq!(child.error, None);
    let child_start = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-start",
        "trace-thread-agent-registry",
        "thread.start_turn",
        json!({
            "threadId": "thread-agent-child",
            "turnId": "turn-agent-child",
            "input": { "content": "research task" }
        }),
    ));
    assert_eq!(child_start.error, None);
    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-checkpoint",
        "trace-thread-agent-registry",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-child",
            "op": {
                "type": "checkpoint",
                "turnId": "turn-agent-child",
                "checkpointId": "checkpoint-child-agent",
                "restorePayload": { "phase": "child_waiting" }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    let approval = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry-child-approval",
        "trace-thread-agent-registry",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-child",
            "op": {
                "type": "approval_request",
                "turnId": "turn-agent-child",
                "approvalId": "approval-child-1",
                "summary": "Allow child tool?"
            }
        }),
    ));
    assert_eq!(approval.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-agent-registry",
        "trace-thread-agent-registry",
        "thread.agent_registry",
        json!({ "threadId": "thread-agent-parent" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["rootThreadId"], "thread-agent-parent");
    assert_eq!(result["total"], 2);
    assert_eq!(result["activeCount"], 2);
    assert_eq!(result["waitingForApprovalCount"], 1);
    assert_eq!(result["agents"][0]["threadId"], "thread-agent-parent");
    assert_eq!(result["agents"][0]["role"], "main");
    assert_eq!(result["agents"][0]["childCount"], 1);
    assert_eq!(result["agents"][1]["agentId"], "child-agent-1");
    assert_eq!(result["agents"][1]["parentThreadId"], "thread-agent-parent");
    assert_eq!(result["agents"][1]["role"], "research");
    assert_eq!(result["agents"][1]["nickname"], "Researcher");
    assert_eq!(
        result["agents"][1]["latestCheckpoint"]["checkpointId"],
        "checkpoint-child-agent"
    );
    assert!(result["agents"][1]["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"] == "approval"));
    assert_eq!(
        result["agents"][1]["pendingApproval"]["approvalId"],
        "approval-child-1"
    );
}

#[test]
fn dispatches_thread_activity_for_activity_rail_summary() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-parent",
        "trace-thread-activity",
        "thread.create",
        json!({
            "threadId": "thread-activity-parent",
            "title": "Activity parent",
            "sessionKey": "session-activity-summary"
        }),
    ));
    assert_eq!(create_parent.error, None);
    let start_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-parent-start",
        "trace-thread-activity",
        "thread.start_turn",
        json!({
            "threadId": "thread-activity-parent",
            "turnId": "turn-activity-parent",
            "input": { "content": "show activity" }
        }),
    ));
    assert_eq!(start_parent.error, None);
    for (request_id, op) in [
        (
            "req-thread-activity-checkpoint",
            json!({
                "type": "checkpoint",
                "turnId": "turn-activity-parent",
                "checkpointId": "checkpoint-activity-parent",
                "label": "Before tool",
                "restorePayload": { "phase": "before_tool" }
            }),
        ),
        (
            "req-thread-activity-tool-start",
            json!({
                "type": "tool_call_started",
                "turnId": "turn-activity-parent",
                "toolCallId": "tool-activity-1",
                "toolName": "workspace.read_file",
                "args": { "path": "notes/today.md" }
            }),
        ),
        (
            "req-thread-activity-approval",
            json!({
                "type": "approval_request",
                "turnId": "turn-activity-parent",
                "approvalId": "approval-activity-1",
                "summary": "Allow workspace read?"
            }),
        ),
    ] {
        let response = router.dispatch(&WorkerRequest::new(
            request_id,
            "trace-thread-activity",
            "thread.apply_op",
            json!({
                "threadId": "thread-activity-parent",
                "op": op
            }),
        ));
        assert_eq!(response.error, None);
    }
    let create_child = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-child",
        "trace-thread-activity",
        "thread.create",
        json!({
            "threadId": "thread-activity-child",
            "title": "Activity child",
            "sessionKey": "session-activity-summary",
            "parentThreadId": "thread-activity-parent",
            "source": "subagent",
            "metadata": {
                "extra": {
                    "agentControl": {
                        "agentId": "child-activity-agent",
                        "agentPath": ["main", "child-activity-agent"],
                        "parentThreadId": "thread-activity-parent",
                        "childTurnId": "turn-activity-child",
                        "role": "research",
                        "nickname": "Activity child",
                        "depth": 1,
                        "lifecycle": {
                            "status": "running",
                            "active": true,
                            "terminal": false
                        }
                    }
                }
            }
        }),
    ));
    assert_eq!(create_child.error, None);
    let start_child = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-child-start",
        "trace-thread-activity",
        "thread.start_turn",
        json!({
            "threadId": "thread-activity-child",
            "turnId": "turn-activity-child",
            "input": { "content": "child work" }
        }),
    ));
    assert_eq!(start_child.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-activity",
        "trace-thread-activity",
        "thread.activity",
        json!({ "threadId": "thread-activity-parent" }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-activity-parent");
    assert_eq!(result["summary"]["pendingApprovals"], 1);
    assert_eq!(result["summary"]["runningTools"], 1);
    assert_eq!(result["summary"]["checkpoints"], 1);
    assert_eq!(result["summary"]["activeChildren"], 1);
    assert_eq!(
        result["pendingApprovals"][0]["approvalId"],
        "approval-activity-1"
    );
    assert_eq!(result["runningTools"][0]["toolCallId"], "tool-activity-1");
    assert_eq!(
        result["checkpoints"][0]["checkpointId"],
        "checkpoint-activity-parent"
    );
    assert_eq!(
        result["activeChildren"][0]["child"]["threadId"],
        "thread-activity-child"
    );
    assert_eq!(result["agents"]["activeCount"], 2);
}

#[test]
fn dispatches_thread_activity_excludes_completed_tool_calls() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    assert_eq!(
        router
            .dispatch(&WorkerRequest::new(
                "req-thread-activity-completed-tool-create",
                "trace-thread-activity-completed-tool",
                "thread.create",
                json!({ "threadId": "thread-activity-completed-tool" }),
            ))
            .error,
        None
    );
    assert_eq!(
        router
            .dispatch(&WorkerRequest::new(
                "req-thread-activity-completed-tool-start",
                "trace-thread-activity-completed-tool",
                "thread.start_turn",
                json!({
                    "threadId": "thread-activity-completed-tool",
                    "turnId": "turn-activity-completed-tool",
                    "input": { "content": "run completed tool" }
                }),
            ))
            .error,
        None
    );
    for (request_id, op) in [
        (
            "req-thread-activity-completed-tool-call",
            json!({
                "type": "tool_call_started",
                "turnId": "turn-activity-completed-tool",
                "toolCallId": "tool-completed-1",
                "toolName": "workspace.read_file",
                "args": { "path": "notes/today.md" }
            }),
        ),
        (
            "req-thread-activity-completed-tool-result",
            json!({
                "type": "tool_result",
                "turnId": "turn-activity-completed-tool",
                "toolCallId": "tool-completed-1",
                "toolName": "workspace.read_file",
                "output": { "contents": "done" }
            }),
        ),
    ] {
        assert_eq!(
            router
                .dispatch(&WorkerRequest::new(
                    request_id,
                    "trace-thread-activity-completed-tool",
                    "thread.apply_op",
                    json!({
                        "threadId": "thread-activity-completed-tool",
                        "op": op
                    }),
                ))
                .error,
            None
        );
    }

    let response = router.dispatch(&WorkerRequest::new(
        "req-thread-activity-completed-tool",
        "trace-thread-activity-completed-tool",
        "thread.activity",
        json!({ "threadId": "thread-activity-completed-tool" }),
    ));

    assert_eq!(response.error, None);
    assert_eq!(
        response.result.as_ref().unwrap()["summary"]["runningTools"],
        0
    );
    assert!(response.result.as_ref().unwrap()["runningTools"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn dispatches_tool_executor_execute_for_registered_memory_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::MemoryRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-read",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "memory.search",
            "arguments": { "query": "hello" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["toolId"], "memory.search");
    assert_eq!(result["method"], "memory.search");
    assert_eq!(result["namespace"], "memory");
    assert_eq!(result["exposure"], "deferred");
    assert_eq!(result["approval"]["required"], false);
    assert_eq!(result["permission"]["decision"], "allow");
    assert_eq!(result["permission"]["requiresApproval"], false);
    assert_eq!(result["permission"]["tool"]["toolId"], "memory.search");
    assert_eq!(result["result"]["notes"], json!([]));
}

#[test]
fn dispatches_tool_executor_records_thread_tool_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::MemoryRead,
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-create",
        "trace-tool-executor-thread",
        "thread.create",
        json!({
            "threadId": "thread-tool-executor",
            "title": "Tool executor thread"
        }),
    ));
    assert_eq!(create.error, None);
    let start = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-start",
        "trace-tool-executor-thread",
        "thread.start_turn",
        json!({
            "threadId": "thread-tool-executor",
            "turnId": "turn-tool-executor",
            "input": { "content": "read notes" }
        }),
    ));
    assert_eq!(start.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-read",
        "trace-tool-executor-thread",
        "tool_executor.execute",
        json!({
            "toolId": "memory.search",
            "threadId": "thread-tool-executor",
            "turnId": "turn-tool-executor",
            "toolCallId": "call-tool-executor-read",
            "arguments": { "query": "hello" }
        }),
    ));

    assert_eq!(response.error, None);
    let result = response.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-tool-executor");
    assert_eq!(result["turnId"], "turn-tool-executor");
    assert_eq!(result["toolCallId"], "call-tool-executor-read");
    assert_eq!(result["appendedItems"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["appendedItems"][0]["kind"]["type"],
        "tool_call_started"
    );
    assert_eq!(
        result["appendedItems"][1]["kind"]["type"],
        "tool_call_output"
    );
    assert_eq!(
        result["appendedItems"][1]["parentItemId"],
        result["appendedItems"][0]["itemId"]
    );

    let snapshot = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-thread-snapshot",
        "trace-tool-executor-thread",
        "thread.read",
        json!({ "threadId": "thread-tool-executor" }),
    ));
    assert_eq!(snapshot.error, None);
    let item_kinds = snapshot.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec![
            "user_message",
            "turn_started",
            "tool_call_started",
            "tool_call_output"
        ]
    );
    assert_eq!(
        snapshot.result.as_ref().unwrap()["items"][3]["kind"]["payload"]["output"]["notes"],
        json!([])
    );
}

#[test]
fn dispatches_tool_executor_rejects_unavailable_registered_tool() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-shell-denied",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": "echo blocked",
                "sessionId": "session-1",
                "turnId": "turn-1"
            }
        }),
    ));

    let error = response
        .error
        .expect("unavailable registered tool should be rejected");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.message, "registered tool is unavailable");
    assert_eq!(error.details["toolId"], "shell.execute");
    assert_eq!(error.details["targetMethod"], "shell.execute");
    assert_eq!(
        error.details["missingCapabilities"],
        json!(["shell.execute"])
    );
}

#[test]
fn dispatches_tool_executor_preserves_sensitive_tool_approval_boundary() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    );

    let response = router.dispatch(&WorkerRequest::new(
        "req-tool-executor-shell-approval",
        "trace-tool-executor",
        "tool_executor.execute",
        json!({
            "toolId": "shell.execute",
            "arguments": {
                "command": "echo needs approval",
                "sessionId": "session-1",
                "turnId": "turn-1"
            }
        }),
    ));

    let error = response
        .error
        .expect("sensitive registered tool should still require approval");
    assert_eq!(
        error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(error.message, "approval required for sensitive operation");
    assert_eq!(error.details["method"], "shell.execute");
    assert_eq!(error.details["boundary"], "security");
    assert_eq!(error.details["category"], "shell");
}

#[test]
fn mcp_tool_calls_cannot_bypass_approval_through_low_level_rpc() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({
            "tools": {
                "mcp_servers": {
                    "docs": { "enabled_tools": ["search"] }
                }
            }
        }),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::McpCall]),
    );
    let arguments = json!({
        "server": "docs",
        "tool": "search",
        "arguments": {},
        "internal_operation": true
    });

    let direct = router.dispatch(&WorkerRequest::new(
        "req-direct-mcp",
        "trace-direct-mcp",
        "mcp.call_tool",
        arguments.clone(),
    ));
    let direct_error = direct
        .error
        .expect("direct MCP RPC should require a matching approval");
    assert_eq!(
        direct_error.code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );
    assert_eq!(direct_error.details["boundary"], "security");
    assert_eq!(direct_error.details["method"], "mcp.call_tool");
    assert_eq!(direct_error.details["category"], "mcp_tool");

    let executor = router.dispatch(&WorkerRequest::new(
        "req-executor-mcp",
        "trace-executor-mcp",
        "tool_executor.execute",
        json!({
            "toolId": "mcp.call_tool",
            "arguments": arguments
        }),
    ));
    let executor_error = executor
        .error
        .expect("tool executor MCP RPC should require the trusted approved path");
    assert_eq!(
        executor_error.message,
        "approval-required tools must be dispatched through a trusted approved runtime path"
    );
    assert_eq!(executor_error.details["boundary"], "security");
    assert_eq!(executor_error.details["toolId"], "mcp.call_tool");
}

#[test]
fn dispatches_thread_read_before_sequence_page() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-create",
        "trace-thread-read-before",
        "thread.create",
        json!({ "threadId": "thread-read-before", "title": "Paged thread" }),
    ));
    assert_eq!(create.error, None);

    let items = (1..=5)
        .map(|index| {
            json!({
                "itemId": format!("thread-read-before-item-{index}"),
                "threadId": "",
                "turnId": "turn-read-before",
                "sequence": 0,
                "createdAt": format!("2026-07-05T00:00:0{index}Z"),
                "kind": {
                    "type": "user_message",
                    "payload": { "text": format!("Message {index}") }
                }
            })
        })
        .collect::<Vec<_>>();
    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-append",
        "trace-thread-read-before",
        "thread.append_items",
        json!({ "threadId": "thread-read-before", "items": items }),
    ));
    assert_eq!(append.error, None);

    let page = router.dispatch(&WorkerRequest::new(
        "req-thread-read-before-page",
        "trace-thread-read-before",
        "thread.read",
        json!({ "threadId": "thread-read-before", "limit": 2, "beforeSequence": 7 }),
    ));
    assert_eq!(page.error, None);
    let items = page.result.as_ref().unwrap()["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["sequence"], 4);
    assert_eq!(items[1]["sequence"], 5);
    assert_eq!(
        page.result.as_ref().unwrap()["pagination"]["previousCursor"],
        "4"
    );
    assert_eq!(
        page.result.as_ref().unwrap()["pagination"]["hasMoreBefore"],
        true
    );

    let checkpoint_append = router.dispatch(&WorkerRequest::new(
        "req-thread-read-checkpoint-append",
        "trace-thread-read-before",
        "thread.append_items",
        json!({
            "threadId": "thread-read-before",
            "items": [
                {
                    "itemId": "thread-read-before-checkpoint",
                    "threadId": "",
                    "turnId": "turn-read-before",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:06Z",
                    "kind": {
                        "type": "checkpoint_created",
                        "payload": {
                            "checkpointId": "checkpoint-read-before",
                            "turnId": "turn-read-before",
                            "restorePayload": { "phase": "awaiting_tool" }
                        }
                    }
                },
                {
                    "itemId": "thread-read-before-after-checkpoint",
                    "threadId": "",
                    "turnId": "turn-read-before",
                    "sequence": 0,
                    "createdAt": "2026-07-05T00:00:07Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "text": "After checkpoint" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(checkpoint_append.error, None);

    let checkpoint_page = router.dispatch(&WorkerRequest::new(
        "req-thread-read-checkpoint-page",
        "trace-thread-read-before",
        "thread.read",
        json!({
            "threadId": "thread-read-before",
            "checkpointId": "checkpoint-read-before"
        }),
    ));
    assert_eq!(checkpoint_page.error, None);
    let checkpoint_items = checkpoint_page.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap();
    assert_eq!(checkpoint_items[0]["sequence"], 6);
    assert_eq!(checkpoint_items[0]["kind"]["type"], "checkpoint_created");
    assert_eq!(checkpoint_items[1]["sequence"], 7);
    assert_eq!(
        checkpoint_page.result.as_ref().unwrap()["latestCheckpoint"]["checkpointId"],
        "checkpoint-read-before"
    );
}

#[test]
fn dispatches_thread_append_items_idempotently_by_client_event_id() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-create",
        "trace-thread-idempotent",
        "thread.create",
        json!({ "title": "Idempotent thread" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let payload = json!({
        "threadId": thread_id,
        "clientEventId": "client-event-1",
        "items": [{
            "itemId": "",
            "threadId": "",
            "turnId": "turn-idempotent",
            "sequence": 0,
            "createdAt": "",
            "kind": {
                "type": "user_message",
                "payload": { "text": "retry-safe input" }
            }
        }]
    });

    let first = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-first",
        "trace-thread-idempotent",
        "thread.append_items",
        payload.clone(),
    ));
    assert_eq!(first.error, None);
    let first_item_id = first.result.as_ref().unwrap()["items"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let retry = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-retry",
        "trace-thread-idempotent",
        "thread.append_items",
        payload,
    ));
    assert_eq!(retry.error, None);
    assert_eq!(
        retry.result.as_ref().unwrap()["items"][0]["itemId"],
        first_item_id
    );
    assert_eq!(retry.result.as_ref().unwrap()["items"][0]["sequence"], 1);

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-idempotent-read",
        "trace-thread-idempotent",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(read.result.as_ref().unwrap()["pagination"]["itemCount"], 1);
    assert_eq!(
        read.result.as_ref().unwrap()["items"][0]["kind"]["payload"]["text"],
        "retry-safe input"
    );
}

#[test]
fn dispatches_thread_apply_op_for_turn_lifecycle() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-create",
        "trace-thread-op",
        "thread.create",
        json!({ "title": "Thread op" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-user-input",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "user-input-client-1",
            "op": {
                "type": "user_input",
                "turnId": "turn-op-1",
                "input": { "text": "Summarize this document" },
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(user_input.error, None);
    assert_eq!(
        user_input.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        user_input.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "user_message"
    );
    let first_user_item_id = user_input.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_started_item_id = user_input.result.as_ref().unwrap()["appendedItems"][1]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-user-input-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "user-input-client-1",
            "op": {
                "type": "user_input",
                "turnId": "turn-op-1",
                "input": { "text": "This retry must not append" },
                "model": "deepseek-v4-flash"
            }
        }),
    ));
    assert_eq!(user_input_retry.error, None);
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        first_user_item_id
    );
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
        first_started_item_id
    );
    assert_eq!(
        user_input_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["text"],
        "Summarize this document"
    );

    let continue_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "continue-client-1",
            "op": {
                "type": "continue_turn",
                "input": { "approval": "continue" }
            }
        }),
    ));
    assert_eq!(continue_turn.error, None);
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        continue_turn.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );
    let continue_item_id = continue_turn.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let continue_turn_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "continue-client-1",
            "op": {
                "type": "continue_turn",
                "input": { "approval": "retry should not append" }
            }
        }),
    ));
    assert_eq!(continue_turn_retry.error, None);
    assert_eq!(
        continue_turn_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        continue_item_id
    );
    assert_eq!(
        continue_turn_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["payload"]["approval"],
        "continue"
    );

    let checkpoint = router.dispatch(&WorkerRequest::new(
        "req-thread-op-checkpoint",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "checkpoint",
                "checkpointId": "checkpoint-op-1",
                "label": "After outline",
                "restorePayload": {
                    "phase": "outlined",
                    "note": "resume from outline"
                }
            }
        }),
    ));
    assert_eq!(checkpoint.error, None);
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "checkpoint_created"
    );
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["checkpointId"],
        "checkpoint-op-1"
    );
    assert_eq!(
        checkpoint.result.as_ref().unwrap()["snapshot"]["latestCheckpoint"]["restorePayload"]
            ["phase"],
        "outlined"
    );

    let approval_request = router.dispatch(&WorkerRequest::new(
        "req-thread-op-approval-request",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "approval_request",
                "approvalId": "approval-op-1",
                "summary": "Allow workspace read",
                "scope": "once",
                "payload": {
                    "reason": "Read workspace file"
                }
            }
        }),
    ));
    assert_eq!(approval_request.error, None);
    assert_eq!(
        approval_request.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "approval_requested"
    );
    let approval_request_item_id = approval_request.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let tool_call_start = router.dispatch(&WorkerRequest::new(
        "req-thread-op-tool-call-start",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_call_started",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "args": {
                    "path": "README.md"
                }
            }
        }),
    ));
    assert_eq!(tool_call_start.error, None);
    assert_eq!(
        tool_call_start.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "tool_call_started"
    );
    let tool_call_start_item_id = tool_call_start.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let approval = router.dispatch(&WorkerRequest::new(
        "req-thread-op-approval",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "approval_decision",
                "approvalId": "approval-op-1",
                "approved": true,
                "scope": "once",
                "guidance": "Allowed for this turn"
            }
        }),
    ));
    assert_eq!(approval.error, None);
    assert_eq!(
        approval.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "approval_resolved"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["approvalId"],
        "approval-op-1"
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
        approval_request_item_id
    );
    assert_eq!(
        approval.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "running"
    );

    let tool_result = router.dispatch(&WorkerRequest::new(
        "req-thread-op-tool-result",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_result",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "output": { "text": "README contents" }
            }
        }),
    ));
    assert_eq!(tool_result.error, None);
    assert_eq!(
        tool_result.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "tool_call_output"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["toolCallId"],
        "tool-call-op-1"
    );
    assert_eq!(
        tool_result.result.as_ref().unwrap()["appendedItems"][0]["parentItemId"],
        tool_call_start_item_id
    );

    let assistant_delta = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-delta",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "assistant_delta",
                "delta": "The document",
                "message": {
                    "role": "assistant",
                    "delta": "The document"
                }
            }
        }),
    ));
    assert_eq!(assistant_delta.error, None);
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["turn"]["active"],
        true
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "assistant_message_delta"
    );
    assert_eq!(
        assistant_delta.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["delta"],
        "The document"
    );

    let reasoning = router.dispatch(&WorkerRequest::new(
        "req-thread-op-reasoning",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "reasoning",
                "summary": "Need to synthesize the uploaded document.",
                "payload": {
                    "phase": "synthesis"
                }
            }
        }),
    ));
    assert_eq!(reasoning.error, None);
    assert_eq!(
        reasoning.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "reasoning"
    );
    assert_eq!(
        reasoning.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["summary"],
        "Need to synthesize the uploaded document."
    );

    let assistant_response = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-response",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "assistant-response-client-1",
            "op": {
                "type": "assistant_response",
                "content": "The document is summarized.",
                "stopReason": "final_response"
            }
        }),
    ));
    assert_eq!(assistant_response.error, None);
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-1"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["turn"]["active"],
        false
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "assistant_message_completed"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["appendedItems"][1]["kind"]["type"],
        "turn_completed"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );
    assert_eq!(
        assistant_response.result.as_ref().unwrap()["snapshot"]["activeTurn"],
        json!(null)
    );
    let assistant_message_item_id = assistant_response.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();
    let completion_item_id = assistant_response.result.as_ref().unwrap()["appendedItems"][1]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let assistant_response_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-assistant-response-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "assistant-response-client-1",
            "op": {
                "type": "assistant_response",
                "content": "This retry must not append.",
                "stopReason": "retry"
            }
        }),
    ));
    assert_eq!(assistant_response_retry.error, None);
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        assistant_message_item_id
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["itemId"],
        completion_item_id
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["text"],
        "The document is summarized."
    );
    assert_eq!(
        assistant_response_retry.result.as_ref().unwrap()["appendedItems"][1]["kind"]["payload"]
            ["stopReason"],
        "final_response"
    );

    let late_tool_result = router.dispatch(&WorkerRequest::new(
        "req-thread-op-late-tool-result",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "tool_result",
                "turnId": "turn-op-1",
                "toolCallId": "tool-call-op-1",
                "toolName": "workspace.read_file",
                "output": { "text": "late output" }
            }
        }),
    ));
    assert_eq!(
        late_tool_result.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        late_tool_result.error.as_ref().unwrap().message,
        "thread operation targets a turn that is not active"
    );

    let continue_without_active_turn = router.dispatch(&WorkerRequest::new(
        "req-thread-op-continue-without-active-turn",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "continue_turn",
                "input": { "approval": "late continue" }
            }
        }),
    ));
    assert_eq!(
        continue_without_active_turn.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        continue_without_active_turn.error.as_ref().unwrap().message,
        "thread operation requires an active turn or explicit turnId"
    );

    let second_user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-second-user-input",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "turnId": "turn-op-2",
                "input": { "text": "Start another task" }
            }
        }),
    ));
    assert_eq!(second_user_input.error, None);
    assert_eq!(
        second_user_input.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-op-2"
    );

    let interrupt = router.dispatch(&WorkerRequest::new(
        "req-thread-op-interrupt",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "interrupt-client-1",
            "op": {
                "type": "interrupt",
                "reason": "user stopped"
            }
        }),
    ));
    assert_eq!(interrupt.error, None);
    assert_eq!(
        interrupt.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "cancelled"
    );
    assert_eq!(
        interrupt.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "idle"
    );
    let cancelled_item_id = interrupt.result.as_ref().unwrap()["appendedItems"][0]["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let interrupt_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-interrupt-retry",
        "trace-thread-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "interrupt-client-1",
            "op": {
                "type": "interrupt",
                "reason": "retry should not append"
            }
        }),
    ));
    assert_eq!(interrupt_retry.error, None);
    assert_eq!(
        interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        cancelled_item_id
    );
    assert_eq!(
        interrupt_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["reason"],
        "user stopped"
    );
}

#[test]
fn dispatches_thread_apply_op_records_terminal_error() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-create",
        "trace-thread-error-op",
        "thread.create",
        json!({ "title": "Thread error op", "sessionKey": "session-error-op" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-start",
        "trace-thread-error-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "turnId": "turn-error-op-1",
                "input": "Start risky task"
            }
        }),
    ));
    assert_eq!(start.error, None);

    let failed = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-fail",
        "trace-thread-error-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "error",
                "message": "Tool execution failed",
                "code": "tool_error",
                "details": { "toolName": "workspace.write_file" }
            }
        }),
    ));
    assert_eq!(failed.error, None);
    assert_eq!(
        failed.result.as_ref().unwrap()["turn"]["turnId"],
        "turn-error-op-1"
    );
    assert_eq!(failed.result.as_ref().unwrap()["turn"]["status"], "failed");
    assert_eq!(
        failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "error"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["message"],
        "Tool execution failed"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "failed"
    );
    assert_eq!(
        failed.result.as_ref().unwrap()["snapshot"]["activeTurn"],
        json!(null)
    );

    let turn_get = router.dispatch(&WorkerRequest::new(
        "req-thread-error-op-turn-get",
        "trace-thread-error-op",
        "thread.turn.get",
        json!({ "session_id": "session-error-op", "turn_id": "turn-error-op-1" }),
    ));
    assert!(turn_get.result.is_none());
    assert_eq!(
        turn_get.error.as_ref().map(|error| error.message.as_str()),
        Some("turn not found")
    );
}

#[test]
fn dispatches_thread_apply_op_for_subagent_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-create",
        "trace-thread-op-subagent",
        "thread.create",
        json!({ "title": "Thread op subagent" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-user-input",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "user_input",
                "turnId": "turn-subagent-op-1",
                "input": { "text": "Delegate this task" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let spawned = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-spawned",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_spawned",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childTurnId": "turn-child-op-1",
                "name": "Researcher",
                "task": "Find source material",
                "payload": {
                    "role": "research"
                }
            }
        }),
    ));
    assert_eq!(spawned.error, None);
    assert_eq!(
        spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_spawned"
    );
    assert_eq!(
        spawned.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["subagentId"],
        "delegate-op-1"
    );

    let message = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-message",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_message",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childTurnId": "turn-child-op-1",
                "content": "I found two relevant sources.",
                "status": "running",
                "payload": {
                    "sourceCount": 2
                }
            }
        }),
    ));
    assert_eq!(message.error, None);
    assert_eq!(
        message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_message"
    );
    assert_eq!(
        message.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["content"],
        "I found two relevant sources."
    );

    let completed = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-completed",
        "trace-thread-op-subagent",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "op": {
                "type": "subagent_completed",
                "subagentId": "delegate-op-1",
                "childThreadId": "thread-child-op-1",
                "childTurnId": "turn-child-op-1",
                "status": "completed",
                "result": {
                    "summary": "Two sources found"
                }
            }
        }),
    ));
    assert_eq!(completed.error, None);
    assert_eq!(
        completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "subagent_completed"
    );
    assert_eq!(
        completed.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["result"]
            ["summary"],
        "Two sources found"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-subagent-read",
        "trace-thread-op-subagent",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec![
            "user_message",
            "turn_started",
            "subagent_spawned",
            "subagent_message",
            "subagent_completed",
        ]
    );
}

#[test]
fn dispatches_thread_apply_op_for_agent_step_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-create",
        "trace-thread-op-step",
        "thread.create",
        json!({
            "threadId": "thread-agent-step-op",
            "title": "Thread op step",
            "sessionKey": "session-agent-step-op"
        }),
    ));
    assert_eq!(create.error, None);

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-user-input",
        "trace-thread-op-step",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-step-op",
            "op": {
                "type": "user_input",
                "turnId": "turn-agent-step-op",
                "input": { "text": "Run a multi-step task" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let step = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step",
        "trace-thread-op-step",
        "thread.apply_op",
        json!({
            "threadId": "thread-agent-step-op",
            "op": {
                "type": "agent_step",
                "stepId": "step-plan-1",
                "name": "Plan",
                "status": "running",
                "summary": "Preparing the tool plan",
                "payload": {
                    "phase": "planning"
                }
            }
        }),
    ));
    assert_eq!(step.error, None);
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "turn_step"
    );
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["stepId"],
        "step-plan-1"
    );
    assert_eq!(
        step.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["eventName"],
        "agent.step"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-step-read",
        "trace-thread-op-step",
        "thread.read",
        json!({ "threadId": "thread-agent-step-op" }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        item_kinds,
        vec!["user_message", "turn_started", "turn_step"]
    );
}

#[test]
fn dispatches_thread_apply_op_for_runtime_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-create",
        "trace-thread-op-runtime-event",
        "thread.create",
        json!({
            "threadId": "thread-runtime-event-op",
            "title": "Runtime event op",
            "sessionKey": "session-runtime-event-op"
        }),
    ));
    assert_eq!(create.error, None);

    let user_input = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-user-input",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "op": {
                "type": "user_input",
                "turnId": "turn-runtime-event-op",
                "input": { "text": "Search the web" }
            }
        }),
    ));
    assert_eq!(user_input.error, None);

    let runtime_event = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "clientEventId": "runtime-event-client-1",
            "op": {
                "type": "runtime_event",
                "eventName": "agent.browser.search",
                "source": "tool",
                "visibility": "user",
                "payload": {
                    "query": "thread event log design",
                    "resultCount": 4
                }
            }
        }),
    ));
    assert_eq!(runtime_event.error, None);
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["type"],
        "event"
    );
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["eventName"],
        "agent.browser.search"
    );
    assert_eq!(
        runtime_event.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]["payload"]
            ["resultCount"],
        4
    );
    let runtime_event_item_id = runtime_event.result.as_ref().unwrap()["appendedItems"][0]
        ["itemId"]
        .as_str()
        .unwrap()
        .to_string();

    let runtime_event_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-retry",
        "trace-thread-op-runtime-event",
        "thread.apply_op",
        json!({
            "threadId": "thread-runtime-event-op",
            "clientEventId": "runtime-event-client-1",
            "op": {
                "type": "runtime_event",
                "eventName": "agent.browser.search.retry",
                "source": "tool",
                "visibility": "user",
                "payload": {
                    "query": "this should not be appended",
                    "resultCount": 99
                }
            }
        }),
    ));
    assert_eq!(runtime_event_retry.error, None);
    assert_eq!(
        runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["itemId"],
        runtime_event_item_id
    );
    assert_eq!(
        runtime_event_retry.result.as_ref().unwrap()["appendedItems"][0]["kind"]["payload"]
            ["eventName"],
        "agent.browser.search"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-op-runtime-event-read",
        "trace-thread-op-runtime-event",
        "thread.read",
        json!({ "threadId": "thread-runtime-event-op" }),
    ));
    assert_eq!(read.error, None);
    let item_kinds = read.result.as_ref().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"]["type"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(item_kinds, vec!["user_message", "turn_started", "event"]);
}

#[test]
fn dispatches_thread_apply_op_updates_settings_and_records_item() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-create",
        "trace-thread-settings-op",
        "thread.create",
        json!({ "title": "Settings before" }),
    ));
    assert_eq!(create.error, None);
    let thread_id = create.result.as_ref().unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_string();

    let settings = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-apply",
        "trace-thread-settings-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "settings-client-1",
            "op": {
                "type": "update_settings",
                "metadata": {
                    "title": "Settings after",
                    "model": "deepseek-v4-flash",
                    "tags": ["thread", "settings"],
                    "extra": { "temperature": 0.2 }
                },
                "reason": "user changed model"
            }
        }),
    ));
    assert_eq!(settings.error, None);
    assert_eq!(
        settings.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Settings after"
    );
    assert_eq!(
        settings.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
        "deepseek-v4-flash"
    );
    assert_eq!(
        settings.result.as_ref().unwrap()["appendedItems"],
        json!([])
    );
    assert_eq!(settings.result.as_ref().unwrap()["turn"], json!(null));

    let settings_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-retry",
        "trace-thread-settings-op",
        "thread.apply_op",
        json!({
            "threadId": thread_id,
            "clientEventId": "settings-client-1",
            "op": {
                "type": "update_settings",
                "metadata": {
                    "title": "Retry must not apply",
                    "model": "retry-model",
                    "tags": ["retry"],
                    "extra": { "temperature": 1.0 }
                },
                "reason": "retry reason"
            }
        }),
    ));
    assert_eq!(settings_retry.error, None);
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["appendedItems"],
        json!([])
    );
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Settings after"
    );
    assert_eq!(
        settings_retry.result.as_ref().unwrap()["snapshot"]["thread"]["metadata"]["model"],
        "deepseek-v4-flash"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-settings-op-read",
        "trace-thread-settings-op",
        "thread.read",
        json!({ "threadId": thread_id }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["thread"]["title"],
        "Settings after"
    );
    assert_eq!(read.result.as_ref().unwrap()["items"], json!([]));
}

#[test]
fn dispatches_thread_apply_op_for_lifecycle_actions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let create_parent = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-parent",
        "trace-thread-lifecycle-op",
        "thread.create",
        json!({ "threadId": "lifecycle-parent", "title": "Lifecycle parent" }),
    ));
    assert_eq!(create_parent.error, None);
    let create_child = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-child",
        "trace-thread-lifecycle-op",
        "thread.create",
        json!({
            "threadId": "lifecycle-child",
            "title": "Lifecycle child",
            "parentThreadId": "lifecycle-parent",
            "source": "subagent"
        }),
    ));
    assert_eq!(create_child.error, None);

    let archive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-archive",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "op": {
                "type": "archive",
                "archiveChildren": true
            }
        }),
    ));
    assert_eq!(archive.error, None);
    assert_eq!(
        archive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "archived"
    );
    assert_eq!(archive.result.as_ref().unwrap()["appendedItems"], json!([]));

    let archived_child = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-read-archived-child",
        "trace-thread-lifecycle-op",
        "thread.read",
        json!({ "threadId": "lifecycle-child" }),
    ));
    assert_eq!(archived_child.error, None);
    assert_eq!(
        archived_child.result.as_ref().unwrap()["thread"]["status"],
        "archived"
    );

    let unarchive = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-unarchive",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "op": {
                "type": "unarchive",
                "unarchiveChildren": true
            }
        }),
    ));
    assert_eq!(unarchive.error, None);
    assert_eq!(
        unarchive.result.as_ref().unwrap()["snapshot"]["thread"]["status"],
        "empty"
    );

    let fork = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "clientEventId": "fork-client-1",
            "op": {
                "type": "fork",
                "title": "Lifecycle fork",
                "includeChildren": true
            }
        }),
    ));
    assert_eq!(fork.error, None);
    let fork_id = fork.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(fork_id, "lifecycle-parent");
    assert_eq!(
        fork.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Lifecycle fork"
    );
    assert_eq!(
        fork.result.as_ref().unwrap()["snapshot"]["thread"]["parentThreadId"],
        "lifecycle-parent"
    );

    let fork_retry = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-retry",
        "trace-thread-lifecycle-op",
        "thread.apply_op",
        json!({
            "threadId": "lifecycle-parent",
            "clientEventId": "fork-client-1",
            "op": {
                "type": "fork",
                "title": "Retry must not fork again",
                "includeChildren": true
            }
        }),
    ));
    assert_eq!(fork_retry.error, None);
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["threadId"],
        fork_id
    );
    assert_eq!(
        fork_retry.result.as_ref().unwrap()["snapshot"]["thread"]["title"],
        "Lifecycle fork"
    );

    let fork_children = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-children",
        "trace-thread-lifecycle-op",
        "thread.list",
        json!({
            "includeChildThreads": true,
            "parentThreadId": fork_id
        }),
    ));
    assert_eq!(fork_children.error, None);
    assert_eq!(
        fork_children.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let fork_siblings = router.dispatch(&WorkerRequest::new(
        "req-thread-lifecycle-op-fork-siblings",
        "trace-thread-lifecycle-op",
        "thread.list",
        json!({
            "includeChildThreads": true,
            "parentThreadId": "lifecycle-parent"
        }),
    ));
    assert_eq!(fork_siblings.error, None);
    assert_eq!(
        fork_siblings.result.as_ref().unwrap()["threads"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|thread| thread["source"] == "fork")
            .count(),
        1
    );
}

#[test]
fn dispatches_agent_turn_store_round_trip_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let record = json!({
        "sessionId": "session-1",
        "turnId": "turn-1",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "unix-ms:1",
        "updatedAt": "unix-ms:1",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-upsert",
        "trace-agent-turn",
        "thread.turn.start",
        json!({ "record": record }),
    ));
    let invalid_semantic = router.dispatch(&WorkerRequest::new(
        "req-invalid-trace",
        "trace-agent-turn",
        "thread.turn.append_semantic_batch",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "events": [{
                "eventName": "agent.reasoning_delta",
                "payload": {
                    "delta": "must not be persisted",
                    "modelCallId": "provider-invalid",
                    "reasoningId": "reasoning-invalid"
                }
            }]
        }),
    ));
    let invalid_response_semantic = router.dispatch(&WorkerRequest::new(
        "req-invalid-response-trace",
        "trace-agent-turn",
        "thread.turn.append_semantic_batch",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "events": [{
                "eventId": "invalid-reasoning",
                "eventName": "agent.reasoning.completed",
                "payload": {
                    "modelCallId": "provider-invalid",
                    "reasoningId": "reasoning-invalid"
                }
            }]
        }),
    ));
    let append_semantic = router.dispatch(&WorkerRequest::new(
        "req-trace",
        "trace-agent-turn",
        "thread.turn.append_semantic_batch",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "events": [{
                "eventId": "semantic-message",
                "eventName": "agent.message.completed",
                "turnId": "turn-1",
                "payload": {
                    "content": "done",
                    "messageId": "assistant-1",
                    "messagePhase": "final_answer"
                }
            }]
        }),
    ));
    let set_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-set-checkpoint",
        "trace-agent-turn",
        "thread.turn.set_checkpoint",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "checkpoint": { "sessionId": "session-1", "turnId": "turn-1", "phase": "awaiting_tool" }
        }),
    ));
    let get_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-get-checkpoint",
        "trace-agent-turn",
        "thread.turn.get_checkpoint",
        json!({ "session_id": "session-1", "turn_id": "turn-1" }),
    ));
    let list = router.dispatch(&WorkerRequest::new(
        "req-list",
        "trace-agent-turn",
        "thread.turn.list",
        json!({ "sessionId": "session-1" }),
    ));
    let get = router.dispatch(&WorkerRequest::new(
        "req-get",
        "trace-agent-turn",
        "thread.turn.get",
        json!({ "session_id": "session-1", "turn_id": "turn-1" }),
    ));
    let runtime_state = router.dispatch(&WorkerRequest::new(
        "req-runtime-state",
        "trace-agent-turn",
        "thread.turn.runtime_state",
        json!({ "session_id": "session-1", "turn_id": "turn-1" }),
    ));
    let completed = router.dispatch(&WorkerRequest::new(
        "req-complete",
        "trace-agent-turn",
        "thread.turn.mark_completed",
        json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "stop_reason": "final_response",
            "final_content": "done"
        }),
    ));
    let get_completed = router.dispatch(&WorkerRequest::new(
        "req-get-completed",
        "trace-agent-turn",
        "thread.turn.get",
        json!({ "session_id": "session-1", "turn_id": "turn-1" }),
    ));
    let clear_checkpoint = router.dispatch(&WorkerRequest::new(
        "req-clear-checkpoint",
        "trace-agent-turn",
        "thread.turn.clear_checkpoint",
        json!({ "session_id": "session-1", "turn_id": "turn-1" }),
    ));

    assert!(upsert.error.is_none());
    assert!(invalid_semantic.result.is_none());
    assert_eq!(
        invalid_semantic
            .error
            .as_ref()
            .map(|error| error.message.as_str()),
        Some("agent turn semantic event is missing eventId")
    );
    assert!(invalid_response_semantic.result.is_none());
    assert_eq!(
        invalid_response_semantic
            .error
            .as_ref()
            .map(|error| error.message.as_str()),
        Some("semantic runtime event cannot be materialized as a typed response item")
    );
    assert!(append_semantic.error.is_none());
    assert!(set_checkpoint.error.is_none());
    assert_eq!(
        get_checkpoint.result.as_ref().unwrap()["checkpoint"]["phase"],
        "awaiting_tool"
    );
    assert_eq!(upsert.result.as_ref().unwrap()["threadId"], json!(null));
    assert_eq!(
        append_semantic.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(
        set_checkpoint.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(list.result.as_ref().unwrap()["sessionId"], "session-1");
    assert_eq!(
        list.result.as_ref().unwrap()["turns"][0]["turnId"],
        "turn-1"
    );
    assert_eq!(
        list.result.as_ref().unwrap()["turns"][0]["threadId"],
        json!(null)
    );
    assert!(list.result.as_ref().unwrap()["turns"][0]
        .get("traceEvents")
        .is_none());
    assert_eq!(get.result.as_ref().unwrap()["threadId"], json!(null));
    assert!(get.result.as_ref().unwrap().get("traceEvents").is_none());
    assert_eq!(runtime_state.error, None);
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["sessionId"],
        "session-1"
    );
    assert_eq!(
        runtime_state.result.as_ref().unwrap()["runtimeEvents"][0]["turnId"],
        "turn-1"
    );
    let timeline_items = runtime_state.result.as_ref().unwrap()["timeline"]["items"]
        .as_array()
        .unwrap();
    assert_eq!(timeline_items.len(), 1);
    assert_eq!(timeline_items[0]["kind"], "assistant_message");
    assert_eq!(completed.result.as_ref().unwrap()["status"], "completed");
    assert_eq!(completed.result.as_ref().unwrap()["phase"], "completed");
    assert_eq!(completed.result.as_ref().unwrap()["threadId"], json!(null));
    assert_eq!(get_completed.error, None);
    assert_eq!(
        get_completed.result.as_ref().unwrap()["threadId"],
        json!(null)
    );
    assert_eq!(
        get_completed.result.as_ref().unwrap()["stopReason"],
        "final_response"
    );
    assert_eq!(
        clear_checkpoint.result.as_ref().unwrap()["checkpoint"],
        json!(null)
    );

    assert_removed_persistence_paths_absent(&fixture.root);

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-session-metadata-after-agent-turn",
        "trace-agent-turn",
        "session.get_metadata",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(metadata.result.as_ref().unwrap()["session_id"], "session-1");
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["threadSource"],
        "thread_log"
    );
}

#[test]
fn agent_turn_requests_ignore_thread_only_items() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-create",
        "trace-thread-backed-turn",
        "thread.create",
        json!({
            "threadId": "thread-session-1",
            "title": "Thread-backed turn",
            "sessionKey": "session-1",
            "rootTurnId": "turn-thread-only",
            "activeTurnId": "turn-thread-only",
            "source": "agent_turn"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-append",
        "trace-thread-backed-turn",
        "thread.append_items",
        json!({
            "threadId": "thread-session-1",
            "items": [{
                "itemId": "agent-turn:session-1:turn-thread-only:trace:approval-1",
                "threadId": "",
                "turnId": "turn-thread-only",
                "sequence": 0,
                "createdAt": "2026-07-05T00:00:00Z",
                "kind": {
                    "type": "approval_requested",
                    "payload": {
                        "eventId": "approval-1",
                        "eventName": "agent.awaiting_approval",
                        "sessionId": "session-1",
                        "turnId": "turn-thread-only",
                        "sequence": 1,
                        "timestamp": "2026-07-05T00:00:00Z",
                        "payload": {
                            "approvalId": "approval-1",
                            "summary": "Allow workspace.write_file?"
                        }
                    }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let turn_list = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-list",
        "trace-thread-backed-turn",
        "thread.turn.list",
        json!({ "sessionId": "session-1" }),
    ));
    assert_eq!(turn_list.error, None);
    assert_eq!(turn_list.result.as_ref().unwrap()["sessionId"], "session-1");
    assert!(turn_list.result.as_ref().unwrap()["turns"]
        .as_array()
        .unwrap()
        .is_empty());

    let turn_get = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-get",
        "trace-thread-backed-turn",
        "thread.turn.get",
        json!({ "session_id": "session-1", "turn_id": "turn-thread-only" }),
    ));
    assert!(turn_get.result.is_none());
    assert_eq!(
        turn_get.error.as_ref().map(|error| error.message.as_str()),
        Some("turn not found")
    );

    let runtime_state = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-state",
        "trace-thread-backed-turn",
        "thread.turn.runtime_state",
        json!({ "session_id": "session-1", "turn_id": "turn-thread-only" }),
    ));
    assert!(runtime_state.result.is_none());
    assert_eq!(
        runtime_state
            .error
            .as_ref()
            .map(|error| error.message.as_str()),
        Some("turn not found")
    );

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-status",
        "trace-thread-backed-turn",
        "thread.status",
        json!({ "threadId": "thread-session-1" }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["activeTurn"]["turnId"],
        "turn-thread-only"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["turnItems"][0]["kind"],
        "approval"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-backed-turn-read",
        "trace-thread-backed-turn",
        "thread.read",
        json!({ "threadId": "thread-session-1" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["activeTurn"]["turnId"],
        "turn-thread-only"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["turnItems"][0]["kind"],
        "approval"
    );
}

#[test]
fn agent_turn_list_reads_canonical_rollout_turns() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let thread_log_record = json!({
        "sessionId": "session-1",
        "turnId": "turn-thread-log",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-05T00:00:00Z",
        "updatedAt": "2026-07-05T00:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-turn-upsert",
        "trace-mixed-agent-turns",
        "thread.turn.start",
        json!({ "record": thread_log_record }),
    ));
    assert_eq!(upsert.error, None);

    let turn_list = router.dispatch(&WorkerRequest::new(
        "req-mixed-agent-turn-list",
        "trace-mixed-agent-turns",
        "thread.turn.list",
        json!({ "sessionId": "session-1" }),
    ));

    assert_eq!(turn_list.error, None);
    let turns = turn_list.result.as_ref().unwrap()["turns"]
        .as_array()
        .expect("thread.turn.list should return turns");
    assert_eq!(turns.len(), 1);
    assert!(turns.iter().any(|turn| turn["turnId"] == "turn-thread-log"));
}

#[test]
fn dispatches_thread_status_includes_active_child_activity() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let parent = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-parent",
        "trace-thread-child-activity",
        "thread.create",
        json!({
            "threadId": "thread-parent-activity",
            "title": "Parent thread",
            "sessionKey": "session-activity",
            "source": "agent_turn"
        }),
    ));
    assert_eq!(parent.error, None);
    let child = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-child",
        "trace-thread-child-activity",
        "thread.create",
        json!({
            "threadId": "thread-child-activity",
            "title": "Child worker",
            "sessionKey": "session-activity",
            "rootTurnId": "turn-child-active",
            "activeTurnId": "turn-child-active",
            "parentThreadId": "thread-parent-activity",
            "source": "subagent"
        }),
    ));
    assert_eq!(child.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-append",
        "trace-thread-child-activity",
        "thread.append_items",
        json!({
            "threadId": "thread-child-activity",
            "items": [{
                "itemId": "agent-turn:session-activity:turn-child-active:trace:approval-child",
                "threadId": "",
                "turnId": "turn-child-active",
                "sequence": 0,
                "createdAt": "2026-07-05T00:01:00Z",
                "kind": {
                    "type": "approval_requested",
                    "payload": {
                        "eventId": "approval-child",
                        "eventName": "agent.awaiting_approval",
                        "sessionId": "session-activity",
                        "turnId": "turn-child-active",
                        "sequence": 1,
                        "timestamp": "2026-07-05T00:01:00Z",
                        "payload": {
                            "approvalId": "approval-child",
                            "summary": "Allow child write?"
                        }
                    }
                }
            }]
        }),
    ));
    assert_eq!(append.error, None);

    let status = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-status",
        "trace-thread-child-activity",
        "thread.status",
        json!({ "threadId": "thread-parent-activity" }),
    ));
    assert_eq!(status.error, None);
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["activeTurn"]["turnId"],
        "turn-child-active"
    );
    assert_eq!(
        status.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );

    let read = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-read",
        "trace-thread-child-activity",
        "thread.read",
        json!({ "threadId": "thread-parent-activity" }),
    ));
    assert_eq!(read.error, None);
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["activeTurn"]["turnId"],
        "turn-child-active"
    );
    assert_eq!(
        read.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );

    let events = router.dispatch(&WorkerRequest::new(
        "req-thread-child-activity-events",
        "trace-thread-child-activity",
        "thread.events",
        json!({ "threadId": "thread-parent-activity", "afterSequence": 0 }),
    ));
    assert_eq!(events.error, None);
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["activeTurn"]["turnId"],
        "turn-child-active"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["childActivities"][0]["turnItems"][0]["kind"],
        "approval"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["type"],
        "child_activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["childActivity"]["child"]["threadId"],
        "thread-child-activity"
    );
    assert_eq!(
        events.result.as_ref().unwrap()["events"][2]["childActivity"]["turnItems"][0]["kind"],
        "approval"
    );
}

#[test]
fn agent_turn_rpc_enforces_capabilities_and_unknown_turn_errors() {
    let fixture = WorkspaceFixture::new();
    let mut denied_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::default(),
    );
    let denied = denied_router.dispatch(&WorkerRequest::new(
        "req-denied",
        "trace-agent-turn",
        "thread.turn.list",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(
        denied.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::CapabilityDenied
    );

    let mut read_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let missing = read_router.dispatch(&WorkerRequest::new(
        "req-missing",
        "trace-agent-turn",
        "thread.turn.get",
        json!({ "session_id": "session-1", "turn_id": "missing-turn" }),
    ));
    assert_eq!(
        missing.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        missing.error.as_ref().unwrap().details["turn_id"],
        "missing-turn"
    );

    let malformed = read_router.dispatch(&WorkerRequest::new(
        "req-malformed",
        "trace-agent-turn",
        "thread.turn.get",
        json!({ "session_id": "session-1" }),
    ));
    assert_eq!(
        malformed.error.as_ref().unwrap().code,
        crate::protocol::WorkerProtocolErrorCode::InvalidProtocol
    );
    assert_eq!(
        malformed.error.as_ref().unwrap().details["method"],
        "thread.turn.get"
    );
}

#[test]
fn dispatches_session_writes_for_new_experimental_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let set_checkpoint = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.set_checkpoint",
        json!({
            "session_id": "desktop-session-1",
            "checkpoint": { "turnId": "turn-1", "phase": "awaiting_tools" }
        }),
    );
    let append_messages = WorkerRequest::new(
        "req-2",
        "trace-1",
        "session.append_messages",
        json!({
            "session_id": "desktop-session-1",
            "turn_id": "turn-1",
            "messages": [
                { "role": "assistant", "content": "done" }
            ]
        }),
    );

    let checkpoint_response = router.dispatch(&set_checkpoint);
    let append_response = router.dispatch(&append_messages);

    assert_eq!(
        checkpoint_response.result.as_ref().unwrap()["session_id"],
        "desktop-session-1"
    );
    assert_eq!(
        checkpoint_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
        json!({ "turnId": "turn-1", "phase": "awaiting_tools" })
    );
    assert_eq!(
        append_response.result.as_ref().unwrap()["extra"]["messages"],
        json!([{ "role": "assistant", "content": "done", "turnId": "turn-1" }])
    );
    assert!(checkpoint_response.error.is_none());
    assert!(append_response.error.is_none());
}
