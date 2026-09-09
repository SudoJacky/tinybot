use super::*;

fn trace_context() -> AgentTraceContext {
    AgentTraceContext {
        request_id: "request-1".to_string(),
        trace_id: "trace-1".to_string(),
        turn_id: "turn-1".to_string(),
        thread_id: Some("thread-1".to_string()),
        parent_turn_id: None,
    }
}

struct InvalidAfterHook;

impl AgentHook for InvalidAfterHook {
    fn evaluate<'a>(
        &'a self,
        _invocation: &'a AgentHookInvocation,
    ) -> futures_util::future::BoxFuture<'a, Result<AgentHookOutput, String>> {
        Box::pin(async move {
            Ok(AgentHookOutput::Decision(AgentHookDecision::Deny {
                reason: "too late".to_string(),
            }))
        })
    }
}

#[test]
fn invalid_decision_for_stage_fails_instead_of_becoming_success() {
    let pipeline = AgentHookPipeline::default().with_hook(Arc::new(InvalidAfterHook));
    let error = tauri::async_runtime::block_on(pipeline.evaluate(
        AgentHookInvocation::provider(
            AgentHookStage::AfterProviderResponse,
            trace_context(),
            "provider-1".to_string(),
            Some("completed".to_string()),
        ),
        &AgentRuntimeMetrics::isolated(),
    ))
    .expect_err("after-tool denial should be rejected");

    assert!(error.contains("unsupported stage after_provider_response"));
}

#[test]
fn diagnostic_metadata_redacts_sensitive_values_before_emission() {
    struct DiagnosticHook;

    impl AgentHook for DiagnosticHook {
        fn evaluate<'a>(
            &'a self,
            _invocation: &'a AgentHookInvocation,
        ) -> futures_util::future::BoxFuture<'a, Result<AgentHookOutput, String>> {
            Box::pin(async move {
                Ok(AgentHookOutput::Decision(
                    AgentHookDecision::AppendDiagnosticMetadata {
                        metadata: serde_json::json!({
                            "code": "safe-code",
                            "arguments": { "token": "must-not-leak" },
                            "nested": { "apiKey": "must-not-leak" },
                        }),
                    },
                ))
            })
        }
    }

    let evaluation = tauri::async_runtime::block_on(
        AgentHookPipeline::default()
            .with_hook(Arc::new(DiagnosticHook))
            .evaluate(
                AgentHookInvocation::lifecycle(AgentHookStage::TurnStart, trace_context()),
                &AgentRuntimeMetrics::isolated(),
            ),
    )
    .expect("diagnostic hook should evaluate");

    assert_eq!(evaluation.diagnostic_metadata["code"], "safe-code");
    assert_eq!(evaluation.diagnostic_metadata["arguments"], "[redacted]");
    assert_eq!(
        evaluation.diagnostic_metadata["nested"]["apiKey"],
        "[redacted]"
    );
}
#[test]
fn asynchronous_executor_replacement_preserves_conflict_and_run_diagnostics() {
    struct Executor;
    impl AgentHook for Executor {
        fn name(&self) -> &'static str {
            "fixture-executor"
        }
        fn evaluate<'a>(
            &'a self,
            _input: &'a AgentHookInvocation,
        ) -> futures_util::future::BoxFuture<'a, Result<AgentHookOutput, String>> {
            Box::pin(async {
                tokio::task::yield_now().await;
                Ok(AgentHookOutput::Runs(vec![
                    AgentHookRun {
                        hook_name: "first".into(),
                        decision: "allow".into(),
                        updated_input: Some(serde_json::json!({"path":"a"})),
                        additional_context: Some("context".into()),
                        ..Default::default()
                    },
                    AgentHookRun {
                        hook_name: "second".into(),
                        decision: "allow".into(),
                        updated_input: Some(serde_json::json!({"path":"b"})),
                        ..Default::default()
                    },
                ]))
            })
        }
    }
    tauri::async_runtime::block_on(async {
        let pipeline = AgentHookPipeline::default()
            .with_hook(Arc::new(Executor))
            .with_hook(Arc::new(Executor));
        let input = AgentHookInvocation::tool(
            AgentHookStage::BeforeToolUse,
            trace_context(),
            "session".into(),
            "model".into(),
            "local-worker".into(),
            "call".into(),
            "workspace.read_file".into(),
            serde_json::json!({"path":"original"}),
            None,
        );
        let evaluation = pipeline
            .evaluate(input, &AgentRuntimeMetrics::isolated())
            .await
            .unwrap();
        assert_eq!(
            evaluation.command_runs.len(),
            2,
            "reassembly replaces the executor instead of duplicating execution"
        );
        assert!(evaluation
            .denied_reason
            .unwrap()
            .contains("conflicting updatedInput"));
        assert_eq!(evaluation.normalized_input.unwrap()["path"], "a");
        assert_eq!(evaluation.additional_context, ["context"]);
    });
}
