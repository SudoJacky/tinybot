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
    fn evaluate(&self, _invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String> {
        Ok(AgentHookDecision::Deny {
            reason: "too late".to_string(),
        })
    }
}

#[test]
fn invalid_decision_for_stage_fails_instead_of_becoming_success() {
    let pipeline = AgentHookPipeline::default().with_hook(Arc::new(InvalidAfterHook));
    let error = pipeline
        .evaluate(
            AgentHookInvocation::tool(
                AgentHookStage::AfterToolUse,
                trace_context(),
                "tool-1".to_string(),
                "workspace.read_file".to_string(),
                None,
                Some("completed".to_string()),
            ),
            &AgentRuntimeMetrics::isolated(),
        )
        .expect_err("after-tool denial should be rejected");

    assert!(error.contains("unsupported stage after_tool_use"));
}

#[test]
fn diagnostic_metadata_redacts_sensitive_values_before_emission() {
    struct DiagnosticHook;

    impl AgentHook for DiagnosticHook {
        fn evaluate(&self, _invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String> {
            Ok(AgentHookDecision::AppendDiagnosticMetadata {
                metadata: serde_json::json!({
                    "code": "safe-code",
                    "arguments": { "token": "must-not-leak" },
                    "nested": { "apiKey": "must-not-leak" },
                }),
            })
        }
    }

    let evaluation = AgentHookPipeline::default()
        .with_hook(Arc::new(DiagnosticHook))
        .evaluate(
            AgentHookInvocation::lifecycle(AgentHookStage::TurnStart, trace_context()),
            &AgentRuntimeMetrics::isolated(),
        )
        .expect("diagnostic hook should evaluate");

    assert_eq!(evaluation.diagnostic_metadata["code"], "safe-code");
    assert_eq!(evaluation.diagnostic_metadata["arguments"], "[redacted]");
    assert_eq!(
        evaluation.diagnostic_metadata["nested"]["apiKey"],
        "[redacted]"
    );
}
