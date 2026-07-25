use super::*;

fn spawn_params(session_key: &str, subagent_id: &str) -> SubagentSpawnParams {
    SubagentSpawnParams {
        session_key: session_key.to_string(),
        parent_turn_id: Some("parent-turn".to_string()),
        parent_subagent_id: None,
        delegation_depth: None,
        history_mode: None,
        subagent_id: Some(subagent_id.to_string()),
        child_turn_id: Some(format!("child-{subagent_id}")),
        trace_ref: Some(format!("trace-{subagent_id}")),
        name: Some("Researcher".to_string()),
        task: Some("Investigate a bounded topic".to_string()),
        status: None,
        created_at: Some("1000".to_string()),
        metadata: serde_json::json!({ "role": "research" }),
    }
}

#[test]
fn registers_and_lists_subagents_by_session() {
    let manager = SubagentThreadManager::default();
    let result = manager.spawn(spawn_params("session-a", "worker-1"));
    assert!(result.accepted);
    assert_eq!(result.subagent.unwrap().subagent_id, "worker-1");
    assert_eq!(manager.list("session-a").subagents.len(), 1);
    assert!(manager.list("session-b").subagents.is_empty());
}

#[test]
fn query_is_scoped_to_parent_session() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    assert!(
        manager
            .query(SubagentTargetParams {
                session_key: "session-a".to_string(),
                subagent_id: "worker-1".to_string(),
            })
            .found
    );
    let missing = manager.query(SubagentTargetParams {
        session_key: "session-b".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    assert!(!missing.found);
    assert_eq!(
        missing.error.unwrap().code,
        SubagentControlErrorCode::NotFound
    );
}

#[test]
fn enforces_active_capacity_per_session() {
    let manager = SubagentThreadManager::new(1);
    assert!(
        manager
            .spawn(spawn_params("session-a", "worker-1"))
            .accepted
    );
    let rejected = manager.spawn(spawn_params("session-a", "worker-2"));
    assert!(!rejected.accepted);
    assert_eq!(
        rejected.error.unwrap().code,
        SubagentControlErrorCode::CapacityExhausted
    );
    assert!(
        manager
            .spawn(spawn_params("session-b", "worker-2"))
            .accepted
    );
}

#[test]
fn queues_user_input_for_active_subagent() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    let result = manager.enqueue_input(SubagentSendInputParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
        content: "Please continue".to_string(),
        sender: SubagentInputSender::User,
        turn_id: Some("turn-1".to_string()),
        child_turn_id: None,
        trace_ref: None,
        created_at: Some("1001".to_string()),
        metadata: serde_json::json!({ "surface": "test" }),
    });
    assert!(result.accepted);
    assert_eq!(result.delivery, "live_delivered");
    assert_eq!(result.subagent.unwrap().mailbox_depth, 1);
    assert_eq!(
        result.event.unwrap().event_type,
        "agent.delegate.message_queued"
    );
    let consumed = manager.consume_mailbox(SubagentTargetParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    assert_eq!(consumed.len(), 1);
    assert_eq!(consumed[0].sender, SubagentInputSender::User);
}

#[test]
fn inactive_subagent_rejects_direct_input() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    manager.close(SubagentTargetParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    let result = manager.enqueue_input(SubagentSendInputParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
        content: "Are you there?".to_string(),
        sender: SubagentInputSender::User,
        turn_id: None,
        child_turn_id: None,
        trace_ref: None,
        created_at: None,
        metadata: Value::Null,
    });
    assert!(!result.accepted);
    assert_eq!(
        result.error.unwrap().code,
        SubagentControlErrorCode::Inactive
    );
}

#[test]
fn missing_subagent_falls_back_to_queued_only_delivery() {
    let manager = SubagentThreadManager::default();
    let result = manager.enqueue_input(SubagentSendInputParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
        content: "Queue this".to_string(),
        sender: SubagentInputSender::User,
        turn_id: None,
        child_turn_id: None,
        trace_ref: None,
        created_at: None,
        metadata: Value::Null,
    });
    assert!(result.accepted);
    assert_eq!(result.delivery, "queued_for_runtime");
    assert!(result.subagent.is_none());
}

#[test]
fn lifecycle_transitions_preserve_diagnostics() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    let failed = manager.transition(SubagentTransitionParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
        status: SubagentThreadStatus::Failed,
        result_summary: None,
        blocker_summary: Some("tool failed".to_string()),
        pending_approval: None,
        metadata: serde_json::json!({ "error": "boom" }),
    });
    assert!(failed.accepted);
    let summary = failed.subagent.unwrap();
    assert_eq!(summary.status, SubagentThreadStatus::Failed);
    assert_eq!(summary.blocker_summary.as_deref(), Some("tool failed"));
    assert_eq!(failed.event.unwrap().event_type, "agent.delegate.failed");
}

#[test]
fn restart_interrupts_non_terminal_children_only() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    manager.spawn(spawn_params("session-a", "worker-2"));
    manager.transition(SubagentTransitionParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-2".to_string(),
        status: SubagentThreadStatus::Completed,
        result_summary: Some("done".to_string()),
        blocker_summary: None,
        pending_approval: None,
        metadata: Value::Null,
    });
    let interrupted = manager.interrupt_non_terminal("session-a");
    assert_eq!(interrupted.len(), 1);
    assert_eq!(
        interrupted[0].subagent.as_ref().unwrap().status,
        SubagentThreadStatus::Interrupted
    );
    let listed = manager.list("session-a").subagents;
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|subagent| {
        subagent.subagent_id == "worker-1" && subagent.status == SubagentThreadStatus::Interrupted
    }));
    assert!(listed.iter().any(|subagent| {
        subagent.subagent_id == "worker-2" && subagent.status == SubagentThreadStatus::Completed
    }));
}

#[test]
fn restores_interrupted_children_from_non_terminal_trace_events() {
    let manager = SubagentThreadManager::default();
    let restored = manager.restore_interrupted_from_trace_events(
        "session-a",
        &[
            BackgroundTraceEvent {
                event_id: "event-running".to_string(),
                event_type: "agent.delegate.running".to_string(),
                session_key: "session-a".to_string(),
                turn_id: "parent-turn".to_string(),
                parent_step_id: None,
                delegate_id: Some("worker-1".to_string()),
                child_turn_id: Some("child-1".to_string()),
                child_step_id: None,
                trace_ref: Some("trace-1".to_string()),
                sequence: 1,
                created_at: "1000".to_string(),
                payload: serde_json::json!({
                    "name": "Goodall",
                    "task": "Investigate"
                }),
            },
            BackgroundTraceEvent {
                event_id: "event-completed".to_string(),
                event_type: "agent.delegate.completed".to_string(),
                session_key: "session-a".to_string(),
                turn_id: "parent-turn".to_string(),
                parent_step_id: None,
                delegate_id: Some("worker-2".to_string()),
                child_turn_id: Some("child-2".to_string()),
                child_step_id: None,
                trace_ref: Some("trace-2".to_string()),
                sequence: 2,
                created_at: "1001".to_string(),
                payload: serde_json::json!({ "status": "completed" }),
            },
        ],
    );
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].subagent_id, "worker-1");
    assert_eq!(restored[0].status, SubagentThreadStatus::Interrupted);
    assert_eq!(manager.list("session-a").subagents.len(), 1);
}

#[test]
fn enforces_global_capacity_and_delegation_depth() {
    let manager = SubagentThreadManager::with_limits(2, 2, 2);
    assert!(manager.spawn(spawn_params("session-a", "root-a")).accepted);
    assert!(manager.spawn(spawn_params("session-b", "root-b")).accepted);

    let global_rejection = manager.spawn(spawn_params("session-c", "root-c"));
    assert!(!global_rejection.accepted);
    assert_eq!(
        global_rejection.error.unwrap().code,
        SubagentControlErrorCode::CapacityExhausted
    );

    manager.close(SubagentTargetParams {
        session_key: "session-b".to_string(),
        subagent_id: "root-b".to_string(),
    });
    let mut nested = spawn_params("session-a", "nested-a");
    nested.parent_subagent_id = Some("root-a".to_string());
    nested.delegation_depth = Some(2);
    assert!(manager.spawn(nested).accepted);

    let mut too_deep = spawn_params("session-a", "too-deep");
    too_deep.parent_subagent_id = Some("nested-a".to_string());
    too_deep.delegation_depth = Some(3);
    let depth_rejection = manager.spawn(too_deep);
    assert!(!depth_rejection.accepted);
    assert_eq!(
        depth_rejection.error.unwrap().code,
        SubagentControlErrorCode::DepthExceeded
    );
}

#[test]
fn interrupted_children_resume_selectively_but_closed_children_stay_closed() {
    let manager = SubagentThreadManager::with_limits(2, 4, 3);
    manager.spawn(spawn_params("session-a", "worker-1"));
    manager.spawn(spawn_params("session-a", "worker-2"));
    manager.interrupt_non_terminal("session-a");

    let resumed = manager.resume(SubagentTargetParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    assert!(resumed.accepted);
    assert_eq!(
        resumed.subagent.as_ref().unwrap().status,
        SubagentThreadStatus::Running
    );
    assert_eq!(
        resumed.event.as_ref().unwrap().event_type,
        "agent.delegate.resumed"
    );

    let statuses = manager.list("session-a").subagents;
    assert_eq!(statuses.len(), 2);
    assert_eq!(statuses[0].status, SubagentThreadStatus::Running);
    assert_eq!(statuses[1].status, SubagentThreadStatus::Interrupted);

    manager.close(SubagentTargetParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    let closed_resume = manager.resume(SubagentTargetParams {
        session_key: "session-a".to_string(),
        subagent_id: "worker-1".to_string(),
    });
    assert!(!closed_resume.accepted);
    assert_eq!(
        closed_resume.error.unwrap().code,
        SubagentControlErrorCode::Forbidden
    );
    assert_eq!(manager.list("session-a").subagents.len(), 1);
}

#[test]
fn wait_blocks_until_a_child_reaches_a_lifecycle_boundary() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));
    let transition_manager = manager.clone();
    let transition = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(20));
        transition_manager.transition(SubagentTransitionParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
            status: SubagentThreadStatus::Completed,
            result_summary: Some("done".to_string()),
            blocker_summary: None,
            pending_approval: None,
            metadata: Value::Null,
        })
    });

    let result = manager.wait(SubagentWaitParams {
        session_key: "session-a".to_string(),
        subagent_ids: vec!["worker-1".to_string()],
        timeout_ms: Some(500),
    });
    assert!(transition.join().unwrap().accepted);
    assert!(!result.timed_out);
    assert_eq!(result.statuses[0].status, SubagentThreadStatus::Completed);
}

#[test]
fn wait_stops_when_the_parent_turn_is_cancelled() {
    let manager = SubagentThreadManager::default();
    manager.spawn(spawn_params("session-a", "worker-1"));

    let result = manager.wait_with_cancellation(
        SubagentWaitParams {
            session_key: "session-a".to_string(),
            subagent_ids: vec!["worker-1".to_string()],
            timeout_ms: Some(500),
        },
        || true,
    );

    assert!(result.cancelled);
    assert!(!result.timed_out);
    assert_eq!(result.statuses[0].status, SubagentThreadStatus::Running);
}
