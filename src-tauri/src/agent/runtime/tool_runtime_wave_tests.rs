use super::*;

fn test_call(index: usize) -> NativeAgentToolCall {
    NativeAgentToolCall {
        id: format!("call-{index}"),
        name: format!("tool-{index}"),
        arguments_json: "{}".to_string(),
        result: Value::Null,
    }
}

fn planned(index: usize, mode: ToolExecutionMode) -> PlannedToolCall {
    PlannedToolCall {
        index,
        tool_call: test_call(index),
        mode,
    }
}

fn completed(index: usize) -> IndexedToolDispatchOutcome {
    let tool_call = test_call(index);
    IndexedToolDispatchOutcome {
        index,
        outcome: ToolDispatchOutcome::Completed(ToolDispatchCompleted {
            result: super::super::NativeAgentToolResult::generic_success(
                &tool_call,
                Value::String(format!("result-{index}")),
            ),
            tool_call,
        }),
    }
}

fn cancelled(index: usize) -> IndexedToolDispatchOutcome {
    IndexedToolDispatchOutcome {
        index,
        outcome: ToolDispatchOutcome::Cancelled {
            tool_call: test_call(index),
        },
    }
}

fn runtime_failure(index: usize) -> IndexedToolDispatchOutcome {
    IndexedToolDispatchOutcome {
        index,
        outcome: ToolDispatchOutcome::RuntimeFailure {
            tool_call: test_call(index),
            error: format!("failure-{index}"),
        },
    }
}

fn cleanup_timeout(index: usize) -> IndexedToolDispatchOutcome {
    IndexedToolDispatchOutcome {
        index,
        outcome: ToolDispatchOutcome::CleanupTimedOut {
            tool_call: test_call(index),
            cancellation_mode: ToolCancellationMode::DetachForbidden,
            timeout_ms: 25,
        },
    }
}

#[test]
fn model_ordered_calls_are_partitioned_into_parallel_and_exclusive_waves() {
    let waves = plan_tool_waves(vec![
        planned(0, ToolExecutionMode::Parallel),
        planned(1, ToolExecutionMode::Parallel),
        planned(2, ToolExecutionMode::Exclusive),
        planned(3, ToolExecutionMode::Parallel),
        planned(4, ToolExecutionMode::Exclusive),
        planned(5, ToolExecutionMode::Exclusive),
        planned(6, ToolExecutionMode::Parallel),
    ]);

    assert_eq!(waves.len(), 6);
    assert!(matches!(
        &waves[0],
        ToolWave::Parallel(calls)
            if calls.iter().map(|call| call.index).collect::<Vec<_>>() == vec![0, 1]
    ));
    assert!(matches!(
        &waves[1],
        ToolWave::Exclusive(call) if call.index == 2
    ));
    assert!(matches!(
        &waves[2],
        ToolWave::Parallel(calls)
            if calls.iter().map(|call| call.index).collect::<Vec<_>>() == vec![3]
    ));
    assert!(matches!(
        &waves[3],
        ToolWave::Exclusive(call) if call.index == 4
    ));
    assert!(matches!(
        &waves[4],
        ToolWave::Exclusive(call) if call.index == 5
    ));
    assert!(matches!(
        &waves[5],
        ToolWave::Parallel(calls)
            if calls.iter().map(|call| call.index).collect::<Vec<_>>() == vec![6]
    ));
}

#[test]
fn wave_reduction_commits_only_the_model_ordered_completed_prefix() {
    let decision = reduce_wave_outcomes(vec![completed(2), completed(0), cancelled(1)]);

    assert_eq!(
        decision
            .completed
            .iter()
            .map(|completed| completed.tool_call.id.as_str())
            .collect::<Vec<_>>(),
        vec!["call-0"]
    );
    assert!(matches!(
        decision.terminal,
        Some(IndexedToolDispatchOutcome {
            index: 1,
            outcome: ToolDispatchOutcome::Cancelled { .. },
        })
    ));
    assert_eq!(decision.ignored.len(), 1);
    assert_eq!(decision.ignored[0].index, 2);
}

#[test]
fn wave_reduction_uses_deterministic_terminal_precedence_and_model_index() {
    let decision = reduce_wave_outcomes(vec![
        cancelled(0),
        runtime_failure(1),
        cleanup_timeout(3),
        cleanup_timeout(2),
    ]);

    assert!(decision.completed.is_empty());
    assert!(matches!(
        decision.terminal,
        Some(IndexedToolDispatchOutcome {
            index: 2,
            outcome: ToolDispatchOutcome::CleanupTimedOut { .. },
        })
    ));
    assert_eq!(
        decision
            .ignored
            .iter()
            .map(|outcome| outcome.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 3]
    );
}

#[test]
fn wave_reduction_selects_lowest_model_index_runtime_failure() {
    let decision = reduce_wave_outcomes(vec![runtime_failure(3), completed(0), runtime_failure(1)]);

    assert_eq!(decision.completed.len(), 1);
    assert!(matches!(
        decision.terminal,
        Some(IndexedToolDispatchOutcome {
            index: 1,
            outcome: ToolDispatchOutcome::RuntimeFailure { .. },
        })
    ));
    assert_eq!(decision.ignored.len(), 1);
    assert_eq!(decision.ignored[0].index, 3);
}
