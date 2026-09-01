use super::{
    apply_turn_working_directory, native_agent_graph_tool_result,
    native_agent_tool_executor_should_fallback, native_mcp_failure_result,
    native_mcp_runtime_error_result, native_mcp_tool_result, native_tool_executor_model_content,
    native_tool_result_from_executor_response, native_web_tool_result,
};
use crate::agent::runtime::{NativeAgentToolCall, NativeToolRetry, PreparedToolCall};
use crate::runtime::mcp::{McpRuntimeError, McpRuntimeErrorKind};

#[test]
fn retired_subagent_aliases_do_not_bypass_the_tool_executor() {
    for alias in [
        "spawn_agent",
        "send_input",
        "wait_agent",
        "close_agent",
        "resume_agent",
    ] {
        assert!(
            !native_agent_tool_executor_should_fallback(alias),
            "{alias}"
        );
    }

    assert!(native_agent_tool_executor_should_fallback("subagent.query"));
    assert!(native_agent_tool_executor_should_fallback(
        "subagent.cancel"
    ));
}

#[test]
fn completed_agent_graph_returns_only_the_final_output_to_the_model() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-graph".to_string(),
        name: "agent_graph.run.graph-1".to_string(),
        arguments_json: r#"{"input":"fresh alert"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");

    let result = native_agent_graph_tool_result(
        &tool_call,
        serde_json::json!({
            "id": "run-1",
            "status": "completed",
            "input": "fresh alert",
            "output": "final analysis"
        }),
    )
    .expect("completed graph run should become a tool result");

    assert_eq!(result.envelope["modelContent"], "final analysis");
    assert_eq!(result.envelope["raw"]["graphRunId"], "run-1");
    assert_eq!(result.envelope["raw"]["status"], "completed");
    assert_eq!(result.envelope["raw"]["output"], "final analysis");
    assert!(result.envelope["raw"].get("input").is_none());
}

#[test]
fn shell_process_output_uses_terminal_output_as_model_content() {
    let result = serde_json::json!({
        "processId": "process-1",
        "stdout": "first\nsecond\n",
        "stderr": "",
        "output": "first\nsecond\n",
        "chunks": [
            { "sequence": 1, "stream": "stdout", "content": "first\n" },
            { "sequence": 2, "stream": "stdout", "content": "second\n" }
        ]
    });

    let content = native_tool_executor_model_content(&result);
    let compact: serde_json::Value =
        serde_json::from_str(&content).expect("shell model content should remain structured");

    assert_eq!(compact["processId"], "process-1");
    assert_eq!(compact["output"], "first\nsecond\n");
    assert!(compact.get("stdout").is_none());
    assert!(compact.get("stderr").is_none());
    assert!(compact.get("chunks").is_none());
}

#[test]
fn executor_response_keeps_only_the_native_shell_result() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-1".to_string(),
        name: "exec_command".to_string(),
        arguments_json: r#"{"command":"dir /b"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let shell_result = serde_json::json!({
        "processId": "process-1",
        "status": "exited",
        "running": false,
        "exitCode": 0,
        "stdout": "first\nsecond\n",
        "stderr": "",
        "output": "first\nsecond\n",
        "chunks": [
            { "sequence": 1, "stream": "stdout", "content": "first\n" },
            { "sequence": 2, "stream": "stdout", "content": "second\n" }
        ],
        "cursor": 2,
        "truncated": false,
        "droppedBytes": 0
    });
    let executor_response = serde_json::json!({
        "toolId": "exec_command",
        "method": "shell.start",
        "permission": { "decision": "allow" },
        "result": shell_result
    });

    let result = native_tool_result_from_executor_response(&tool_call, executor_response)
        .expect("executor response should become a native result");
    let raw = &result.envelope["raw"];
    let model_content: serde_json::Value = serde_json::from_str(
        result.envelope["modelContent"]
            .as_str()
            .expect("model content should be a string"),
    )
    .expect("model content should be compact JSON");

    assert_eq!(model_content["output"], "first\nsecond\n");
    assert!(model_content.get("stdout").is_none());
    assert_eq!(raw, &shell_result);
    assert!(result.envelope["structured"].get("value").is_none());
    let serialized =
        serde_json::to_string(&result.envelope).expect("native result envelope should serialize");
    assert_eq!(serialized.matches("\"stdout\"").count(), 3);
    assert!(!serialized.contains("permission"));
    assert!(!serialized.contains("executor"));
}

#[test]
fn running_shell_result_exposes_poll_action_and_retry_semantics() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-running".to_string(),
        name: "exec_command".to_string(),
        arguments_json: r#"{"command":"long-task"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let executor_response = serde_json::json!({
        "result": {
            "processId": "process-1",
            "status": "running",
            "running": true,
            "exitCode": null,
            "output": "working",
            "cursor": 7,
            "truncated": false
        }
    });

    let result = native_tool_result_from_executor_response(&tool_call, executor_response)
        .expect("running shell result should be projected");
    let outcome = &result.envelope["structured"]["outcome"];
    let model_content: serde_json::Value = serde_json::from_str(
        result.envelope["modelContent"]
            .as_str()
            .expect("model content should be JSON"),
    )
    .expect("model content should parse");

    assert_eq!(outcome["effect"], "in_progress");
    assert_eq!(outcome["reasonCode"], "shell_process_running");
    assert_eq!(outcome["retry"], "retry_with_updated_state");
    assert_eq!(outcome["nextAction"]["tool"], "write_stdin");
    assert_eq!(outcome["nextAction"]["arguments"]["processId"], "process-1");
    assert_eq!(outcome["nextAction"]["arguments"]["cursor"], 7);
    assert!(model_content["toolOutcome"]["guidance"]
        .as_str()
        .is_some_and(|guidance| guidance.contains("Follow nextAction")));
}

#[test]
fn shell_terminal_special_states_use_structured_outcomes() {
    for (name, raw, effect, reason_code, retry) in [
        (
            "exec_command",
            serde_json::json!({
                "processId": "process-failed",
                "status": "exited",
                "running": false,
                "exitCode": 7,
                "output": "failure"
            }),
            "failed",
            "shell_nonzero_exit",
            "replan",
        ),
        (
            "shell.execute",
            serde_json::json!({
                "exit_code": -1,
                "timed_out": true,
                "cancelled": false,
                "truncated": false,
                "content": "timed out"
            }),
            "timed_out",
            "shell_timed_out",
            "replan",
        ),
        (
            "exec_command",
            serde_json::json!({
                "processId": "process-truncated",
                "status": "exited",
                "running": false,
                "exitCode": 0,
                "output": "partial",
                "truncated": true,
                "droppedBytes": 512
            }),
            "partial_result",
            "shell_output_truncated",
            "do_not_retry",
        ),
    ] {
        let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
            id: format!("call-{reason_code}"),
            name: name.to_string(),
            arguments_json: r#"{"command":"task"}"#.to_string(),
            result: serde_json::Value::Null,
        })
        .expect("tool call should prepare");
        let result = native_tool_result_from_executor_response(
            &tool_call,
            serde_json::json!({ "result": raw }),
        )
        .expect("special shell result should be projected");
        let outcome = &result.envelope["structured"]["outcome"];

        assert_eq!(outcome["effect"], effect, "reason {reason_code}");
        assert_eq!(outcome["reasonCode"], reason_code, "reason {reason_code}");
        assert_eq!(outcome["retry"], retry, "reason {reason_code}");
    }
}

#[test]
fn mcp_error_result_and_configuration_failure_share_outcome_projection() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-mcp".to_string(),
        name: "mcp.docs.search".to_string(),
        arguments_json: r#"{"query":"Tinybot"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let domain_error = native_mcp_tool_result(
        &tool_call,
        serde_json::json!({
            "server": "docs",
            "tool": "search",
            "result": {
                "isError": true,
                "content": [{ "type": "text", "text": "query rejected" }]
            }
        }),
    );
    let configuration_error = native_mcp_failure_result(
        &tool_call,
        Some("docs"),
        Some("search"),
        "user_action_required",
        "mcp_server_disabled",
        "MCP server is disabled: docs".to_string(),
        NativeToolRetry::AfterUserAction,
    );

    assert_eq!(
        domain_error.envelope["structured"]["outcome"]["reasonCode"],
        "mcp_tool_error"
    );
    assert_eq!(
        domain_error.envelope["structured"]["outcome"]["retry"],
        "replan"
    );
    assert_eq!(
        configuration_error.envelope["structured"]["outcome"]["effect"],
        "user_action_required"
    );
    assert_eq!(
        configuration_error.envelope["structured"]["outcome"]["retry"],
        "after_user_action"
    );
    assert_eq!(configuration_error.envelope["raw"]["server"], "docs");
}

#[test]
fn mcp_runtime_error_kind_drives_effect_and_reason_code() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-mcp-timeout".to_string(),
        name: "mcp.docs.search".to_string(),
        arguments_json: r#"{"query":"Tinybot"}"#.to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let result = native_mcp_runtime_error_result(
        &tool_call,
        "search",
        McpRuntimeError {
            kind: McpRuntimeErrorKind::Timeout,
            server: "docs".to_string(),
            transport: "http".to_string(),
            message: "MCP server `docs` timed out during tools/call".to_string(),
            retryable: true,
            cancelled: false,
        },
    );
    let outcome = &result.envelope["structured"]["outcome"];

    assert_eq!(outcome["effect"], "timed_out");
    assert_eq!(outcome["reasonCode"], "mcp_timed_out");
    assert_eq!(outcome["retry"], "replan");
    assert_eq!(result.envelope["raw"]["error"]["transport"], "http");
}

#[test]
fn turn_working_directory_becomes_shell_default_without_overriding_tool_input() {
    let workspace = std::path::PathBuf::from("D:/workspace");
    let turn_directory = workspace.join("project").join("task");
    let mut defaulted = serde_json::json!({ "command": "pwd" });
    apply_turn_working_directory(
        Some(&turn_directory),
        "exec_command",
        &mut defaulted,
        &workspace,
    )
    .expect("turn working directory should become shell default");
    let mut explicit = serde_json::json!({
        "command": "pwd",
        "workingDir": "other"
    });
    apply_turn_working_directory(
        Some(&turn_directory),
        "shell.start",
        &mut explicit,
        &workspace,
    )
    .expect("explicit shell working directory should remain valid");

    assert_eq!(defaulted["workingDir"], "project/task");
    assert_eq!(explicit["workingDir"], "other");
}

#[test]
fn turn_working_directory_preserves_an_absolute_path_outside_the_workspace() {
    let workspace = std::path::PathBuf::from("D:/workspace");
    let mut arguments = serde_json::json!({ "command": "pwd" });

    apply_turn_working_directory(
        Some(std::path::Path::new("D:/outside")),
        "shell.execute",
        &mut arguments,
        &workspace,
    )
    .expect("outside turn working directory should reach shell dispatch");

    assert_eq!(arguments["workingDir"], "D:/outside");
}

#[test]
fn special_web_result_exposes_recovery_guidance_in_the_tool_envelope() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-navigation-required".to_string(),
        name: "web.act".to_string(),
        arguments_json: r#"{"snapshotId":"snapshot-1","action":{"type":"clickTarget"}}"#
            .to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let raw = serde_json::json!({
        "status": "navigation_required",
        "actionExecuted": false,
        "reasonCode": "target_opens_new_window",
        "reason": "This target opens a new browser window.",
        "suggestedUrl": "https://agentskills.io/specification",
        "snapshotId": "snapshot-1"
    });

    let result = native_web_tool_result(&tool_call, raw.clone());
    let outcome = &result.envelope["structured"]["outcome"];
    let model_content: serde_json::Value = serde_json::from_str(
        result.envelope["modelContent"]
            .as_str()
            .expect("model content should be JSON"),
    )
    .expect("model content should parse");

    assert_eq!(result.envelope["status"], "ok");
    assert_eq!(result.envelope["structured"]["kind"], "tool_outcome");
    assert_eq!(outcome["effect"], "alternative_required");
    assert_eq!(outcome["actionExecuted"], false);
    assert_eq!(outcome["retry"], "do_not_retry");
    assert_eq!(outcome["nextAction"]["tool"], "web.open");
    assert_eq!(
        outcome["nextAction"]["arguments"]["url"],
        "https://agentskills.io/specification"
    );
    assert!(outcome.get("guidance").is_none());
    assert!(model_content["toolOutcome"]["guidance"]
        .as_str()
        .is_some_and(|guidance| guidance.contains("Do not repeat the same tool call")));
    assert_eq!(
        result.envelope["summary"],
        "Alternative action required: This target opens a new browser window."
    );
    assert_eq!(result.envelope["ui"]["summary"], result.envelope["summary"]);
    assert_eq!(result.envelope["ui"]["actions"][0]["tool"], "web.open");
    assert_eq!(model_content["result"], raw);
}

#[test]
fn completed_web_result_keeps_the_existing_generic_projection() {
    let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
        id: "call-web-completed".to_string(),
        name: "web.read".to_string(),
        arguments_json: "{}".to_string(),
        result: serde_json::Value::Null,
    })
    .expect("tool call should prepare");
    let raw = serde_json::json!({
        "status": "completed",
        "snapshotId": "snapshot-1"
    });

    let result = native_web_tool_result(&tool_call, raw.clone());

    assert_eq!(result.envelope["structured"]["kind"], "generic_result");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            result.envelope["modelContent"]
                .as_str()
                .expect("model content should be JSON")
        )
        .expect("model content should parse"),
        raw
    );
}

#[test]
fn web_special_statuses_have_explicit_effects_and_retry_dispositions() {
    for (tool_name, status, effect, retry) in [
        ("web.read", "unchanged", "unchanged", "do_not_retry"),
        (
            "web.act",
            "stale_snapshot",
            "stale_state",
            "retry_with_updated_state",
        ),
        (
            "web.act",
            "user_required",
            "user_action_required",
            "after_user_action",
        ),
        ("web.act", "timed_out", "timed_out", "replan"),
    ] {
        let tool_call = PreparedToolCall::prepare(NativeAgentToolCall {
            id: format!("call-{status}"),
            name: tool_name.to_string(),
            arguments_json: "{}".to_string(),
            result: serde_json::Value::Null,
        })
        .expect("tool call should prepare");
        let result = native_web_tool_result(
            &tool_call,
            serde_json::json!({
                "status": status,
                "reasonCode": status,
                "reason": format!("Browser returned {status}")
            }),
        );
        let outcome = &result.envelope["structured"]["outcome"];
        let model_content: serde_json::Value = serde_json::from_str(
            result.envelope["modelContent"]
                .as_str()
                .expect("model content should be JSON"),
        )
        .expect("model content should parse");

        assert_eq!(outcome["effect"], effect, "status {status}");
        assert_eq!(outcome["retry"], retry, "status {status}");
        assert!(outcome.get("guidance").is_none());
        assert!(model_content["toolOutcome"]["guidance"]
            .as_str()
            .is_some_and(|guidance| !guidance.trim().is_empty()));
        assert_eq!(result.envelope["ui"]["summary"], result.envelope["summary"]);
    }
}
