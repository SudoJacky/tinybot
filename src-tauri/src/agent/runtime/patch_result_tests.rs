use super::chat_completions_adapter::ChatCompletionsAdapter;
use super::responses_adapter::ResponsesAdapter;
use super::{NativeAgentToolCall, NativeAgentToolResult};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn patch_result() -> Value {
    json!({
        "files_changed": 1, "hunks_applied": 1,
        "changed_files": [{
            "path": "report.md", "operation": "add",
            "hunks": [{"index": 1, "removed_lines": 0, "added_lines": 1000}],
            "delta": [{"old_start": 1, "new_start": 1, "old_lines": [],
                "new_lines": vec!["unique report content"; 1000]}],
            "delta_truncated": false
        }]
    })
}

#[test]
fn patch_receipt_preserves_raw_diff_without_echoing_it_to_the_model() {
    let raw = patch_result();
    let call = NativeAgentToolCall {
        id: "patch-1".into(),
        name: "apply_patch".into(),
        arguments_json: "{}".into(),
        result: Value::Null,
    };
    let result = NativeAgentToolResult::generic_success(&call, raw.clone());
    let model: Value =
        serde_json::from_str(result.envelope["modelContent"].as_str().unwrap()).unwrap();
    assert_eq!(result.envelope["raw"], raw);
    let mut expected = raw.clone();
    let file = expected["changed_files"][0].as_object_mut().unwrap();
    file.remove("delta");
    file.remove("delta_truncated");
    assert_eq!(model, expected);
    assert_eq!(result.content, result.envelope["modelContent"]);
    assert!(!result.envelope["summary"]
        .as_str()
        .unwrap()
        .contains("unique report content"));
    assert!(result.envelope["metrics"]["modelChars"].as_u64().unwrap() < 500);
}

#[test]
fn patch_history_projects_old_results_for_both_provider_protocols() {
    let raw = patch_result().to_string();
    for name in [
        "apply_patch",
        "workspace.apply_patch",
        "workspace_apply_patch",
    ] {
        let messages = vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"patch-1","type":"function","function":{"name":name,"arguments":"{}"}
            }]}),
            json!({"role":"tool","tool_call_id":"patch-1","content":raw}),
        ];
        let original = messages.clone();
        let chat = ChatCompletionsAdapter::encode_history(&messages, None).unwrap();
        let responses = ResponsesAdapter::encode_history(&messages, None).unwrap();
        for content in [&chat[1]["content"], &responses[1]["output"]] {
            let model: Value = serde_json::from_str(content.as_str().unwrap()).unwrap();
            assert_eq!(model["changed_files"][0]["path"], "report.md");
            assert!(model["changed_files"][0].get("delta").is_none());
        }
        assert_eq!(
            messages, original,
            "projection must not rewrite stored history"
        );

        let items = vec![
            json!({"type":"function_call","call_id":"patch-1","name":name,"arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"patch-1","output":raw}),
        ];
        let original = items.clone();
        let native =
            ResponsesAdapter::encode_history_with_response_items(&[], None, Some(&items)).unwrap();
        let model: Value = serde_json::from_str(native[1]["output"].as_str().unwrap()).unwrap();
        assert!(model["changed_files"][0].get("delta").is_none());
        assert_eq!(items, original);
    }
}

#[test]
fn patch_failure_and_unrelated_tool_output_remain_visible() {
    let content = "patch failed; details={\"committed\":{\"files_changed\":1,\"exact\":true}}";
    let call = NativeAgentToolCall {
        id: "patch-1".into(),
        name: "apply_patch".into(),
        arguments_json: "{}".into(),
        result: Value::Null,
    };
    let error = NativeAgentToolResult::generic_error(&call, content.into());
    assert_eq!(error.envelope["modelContent"], content);
    assert_eq!(error.envelope["status"], "error");

    let messages = vec![
        json!({"role":"assistant","content":null,"tool_calls":[{
            "id":"read-1","type":"function","function":{"name":"exec_command","arguments":"{}"}
        }]}),
        json!({"role":"tool","tool_call_id":"read-1","content":patch_result().to_string()}),
    ];
    let chat = ChatCompletionsAdapter::encode_history(&messages, None).unwrap();
    assert_eq!(chat[1]["content"], messages[1]["content"]);
}

struct PatchProvider {
    requests: Mutex<Vec<Value>>,
}

impl super::test_support::BlockingTestProvider for PatchProvider {
    fn complete(
        &self,
        context: &super::AgentTurnContext,
    ) -> Result<super::NativeAgentProviderResponse, String> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(context.prepared_provider_request().unwrap().clone());
        let tool_calls = if requests.len() == 1 {
            vec![NativeAgentToolCall {
                id: "patch-integration".into(),
                name: "apply_patch".into(),
                arguments_json: json!({"patch": format!(
                    "*** Begin Patch\n*** Add File: report.md\n{}*** End Patch",
                    "+unique report content\n".repeat(1000)
                )})
                .to_string(),
                result: Value::Null,
            }]
        } else {
            Vec::new()
        };
        Ok(super::NativeAgentProviderResponse {
            final_content: if tool_calls.is_empty() {
                "done".into()
            } else {
                String::new()
            },
            reasoning_delta: None,
            usage: None,
            tool_calls,
            response_items: Vec::new(),
        })
    }
}

#[test]
fn patch_execution_sends_compact_next_request_and_reopens_full_review_diff() {
    use super::{
        FakeNativeAgentToolDispatcher, InMemoryNativeAgentCancellation,
        InMemoryNativeAgentCheckpointStore, NativeAgentRuntimeServices,
    };
    use crate::agent::bridge::{run_agent_from_wire_with_services, TestApplicationServices};
    use crate::protocol::capability::default_desktop_capability_policy;
    use crate::threads::workspace_store::WorkspaceThreadStore;

    struct Workspace(std::path::PathBuf);
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let workspace = Workspace(std::env::temp_dir().join(format!(
        "tinybot-patch-receipt-{}",
        crate::protocol::request_id::next_worker_request_correlation().id("test")
    )));
    std::fs::create_dir_all(&workspace.0).unwrap();
    let open = || {
        WorkspaceThreadStore::new_with_data_root(
            workspace.0.clone(),
            workspace.0.join("thread-data"),
            default_desktop_capability_policy(),
        )
    };
    let store = open();
    let provider = Arc::new(PatchProvider {
        requests: Mutex::new(Vec::new()),
    });
    let services = NativeAgentRuntimeServices::new(
        provider.clone(),
        Arc::new(FakeNativeAgentToolDispatcher),
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    )
    .with_thread_store(store.clone());
    tauri::async_runtime::block_on(run_agent_from_wire_with_services(
        services,
        json!({"sessionId":"patch-thread","threadId":"patch-thread",
            "turnId":"patch-turn","model":"fixture-model",
            "messages":[{"role":"user","content":"write the report"}]}),
        workspace.0.clone(),
        json!({}),
        None,
    ))
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace.0.join("report.md")).unwrap(),
        "unique report content\n".repeat(1000)
    );
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let output = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    let model: Value = serde_json::from_str(output).unwrap();
    assert_eq!(model["files_changed"], 1);
    assert_eq!(model["changed_files"][0]["operation"], "add");
    assert!(!output.contains("unique report content"));
    assert!(output.len() < 500);
    store.flush().unwrap();
    let reopened = open();
    let history = reopened
        .agent_history("patch-thread", 100)
        .unwrap()
        .unwrap();
    let replay = ChatCompletionsAdapter::encode_history(&history.messages, None).unwrap();
    assert_eq!(
        replay
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"],
        output
    );
    let snapshot = reopened.read_agent_thread("patch-thread").unwrap();
    let persisted = snapshot
        .items
        .iter()
        .find_map(|item| match &item.kind {
            crate::threads::domain::ThreadItemKind::ToolCallOutput(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        persisted["tinybot_result"]["changed_files"][0]["delta"][0]["new_lines"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
    assert_eq!(persisted["output"], output);
    eprintln!(
        "patch receipt: raw={} bytes, model={} bytes",
        persisted["tinybot_result"].to_string().len(),
        output.len()
    );
}
