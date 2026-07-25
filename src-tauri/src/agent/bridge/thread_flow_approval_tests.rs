use super::{resolve_thread_approval_with_services, ResolveThreadApprovalInput};
use crate::agent::runtime::NativeAgentRuntimeServices;

#[test]
fn thread_approval_resolution_reports_that_tool_approvals_are_disabled() {
    let error = tauri::async_runtime::block_on(resolve_thread_approval_with_services(
        NativeAgentRuntimeServices::default(),
        ResolveThreadApprovalInput {
            thread_id: "thread-live-1".to_string(),
            approval_id: "approval-live-1".to_string(),
            approved: true,
            command_id: "command-live-1".to_string(),
            scope: Some("once".to_string()),
            guidance: None,
        },
        std::path::PathBuf::new(),
        serde_json::json!({}),
    ))
    .expect_err("tool approval resolution should be disabled");

    assert!(error.contains("tool approvals are disabled"));
    assert!(error.contains("approval-live-1"));
}
