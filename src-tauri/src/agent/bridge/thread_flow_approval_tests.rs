use super::{resolve_thread_approval_with_services, ResolveThreadApprovalInput};
use crate::agent::runtime::approvals::{ApprovalRegistration, NativeAgentApprovalRequest};
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::agent::runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};

#[test]
fn thread_approval_resolution_only_delivers_the_decision() {
    let services = NativeAgentRuntimeServices::default();
    let receiver = match services
        .approval_broker()
        .register(NativeAgentApprovalRequest {
            approval_id: "approval-live-1".to_string(),
            session_id: "thread-live-1".to_string(),
            turn_id: "turn-live-1".to_string(),
            scope_key: "exec:echo-hi".to_string(),
        })
        .expect("approval should register")
    {
        ApprovalRegistration::Pending(receiver) => receiver,
        ApprovalRegistration::ApprovedForSession(_) => panic!("unexpected session grant"),
    };

    let result = tauri::async_runtime::block_on(resolve_thread_approval_with_services(
        services,
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
    .expect("approval decision should be delivered");
    assert_eq!(result["approvalResult"]["delivered"], true);
    assert_eq!(result["approvalResult"]["status"], "approved");

    let resolution = tauri::async_runtime::block_on(receiver)
        .expect("original tool future should receive the decision");
    assert_eq!(resolution.decision, AgentApprovalDecision::Approved);
    assert_eq!(resolution.scope, AgentApprovalScope::Once);
    assert_eq!(resolution.command_id.as_deref(), Some("command-live-1"));
}
