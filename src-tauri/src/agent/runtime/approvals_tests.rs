use super::{ApprovalRegistration, NativeAgentApprovalBroker, NativeAgentApprovalRequest};
use crate::agent::runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};

fn request(approval_id: &str, session_id: &str, scope_key: &str) -> NativeAgentApprovalRequest {
    NativeAgentApprovalRequest {
        approval_id: approval_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: "turn-1".to_string(),
        scope_key: scope_key.to_string(),
    }
}

#[tokio::test]
async fn registered_approval_is_resolved_without_running_the_tool_in_the_resolver() {
    let broker = NativeAgentApprovalBroker::default();
    let receiver = match broker
        .register(request("approval-1", "thread-1", "exec:echo-hi"))
        .expect("approval should register")
    {
        ApprovalRegistration::Pending(receiver) => receiver,
        ApprovalRegistration::ApprovedForSession(_) => panic!("unexpected session grant"),
    };

    let acknowledgement = broker
        .resolve(
            "thread-1",
            "approval-1",
            AgentApprovalDecision::Approved,
            AgentApprovalScope::Once,
            None,
            Some("command-1".to_string()),
        )
        .expect("decision should be delivered");

    assert_eq!(acknowledgement.approval_id, "approval-1");
    assert_eq!(acknowledgement.decision, AgentApprovalDecision::Approved);
    let resolution = receiver.await.expect("tool future should receive decision");
    assert_eq!(resolution.scope, AgentApprovalScope::Once);
    assert_eq!(resolution.command_id.as_deref(), Some("command-1"));
}

#[tokio::test]
async fn session_grants_are_exact_and_scoped_to_the_thread() {
    let broker = NativeAgentApprovalBroker::default();
    let receiver = match broker
        .register(request("approval-1", "thread-1", "exec:echo-hi"))
        .expect("approval should register")
    {
        ApprovalRegistration::Pending(receiver) => receiver,
        ApprovalRegistration::ApprovedForSession(_) => panic!("unexpected session grant"),
    };
    broker
        .resolve(
            "thread-1",
            "approval-1",
            AgentApprovalDecision::Approved,
            AgentApprovalScope::Session,
            None,
            None,
        )
        .expect("session decision should be delivered");
    receiver.await.expect("original tool future should resume");

    assert!(matches!(
        broker
            .register(request("approval-2", "thread-1", "exec:echo-hi"))
            .expect("same exact command should register"),
        ApprovalRegistration::ApprovedForSession(_)
    ));
    assert!(matches!(
        broker
            .register(request("approval-3", "thread-1", "exec:echo-bye"))
            .expect("different command should register"),
        ApprovalRegistration::Pending(_)
    ));
    assert!(matches!(
        broker
            .register(request("approval-4", "thread-2", "exec:echo-hi"))
            .expect("different thread should register"),
        ApprovalRegistration::Pending(_)
    ));
}
