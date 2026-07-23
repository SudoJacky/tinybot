use crate::agent::runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Clone, Debug)]
pub(crate) struct NativeAgentApprovalRequest {
    pub(crate) approval_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) scope_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeAgentApprovalResolution {
    pub(crate) approval_id: String,
    pub(crate) decision: AgentApprovalDecision,
    pub(crate) scope: AgentApprovalScope,
    pub(crate) guidance: Option<String>,
    pub(crate) command_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeAgentApprovalAcknowledgement {
    pub(crate) approval_id: String,
    pub(crate) decision: AgentApprovalDecision,
    pub(crate) scope: AgentApprovalScope,
    pub(crate) command_id: Option<String>,
}

pub(crate) enum ApprovalRegistration {
    ApprovedForSession(NativeAgentApprovalResolution),
    Pending(oneshot::Receiver<NativeAgentApprovalResolution>),
}

struct PendingApproval {
    request: NativeAgentApprovalRequest,
    sender: oneshot::Sender<NativeAgentApprovalResolution>,
}

#[derive(Default)]
struct NativeAgentApprovalState {
    pending: HashMap<String, PendingApproval>,
    session_grants: HashSet<(String, String)>,
}

#[derive(Clone, Default)]
pub(crate) struct NativeAgentApprovalBroker {
    state: Arc<Mutex<NativeAgentApprovalState>>,
}

impl NativeAgentApprovalBroker {
    pub(crate) fn register(
        &self,
        request: NativeAgentApprovalRequest,
    ) -> Result<ApprovalRegistration, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "native approval state lock is poisoned".to_string())?;
        if state
            .session_grants
            .contains(&(request.session_id.clone(), request.scope_key.clone()))
        {
            return Ok(ApprovalRegistration::ApprovedForSession(
                NativeAgentApprovalResolution {
                    approval_id: request.approval_id,
                    decision: AgentApprovalDecision::Approved,
                    scope: AgentApprovalScope::Session,
                    guidance: None,
                    command_id: None,
                },
            ));
        }
        if state.pending.contains_key(&request.approval_id) {
            return Err(format!(
                "native approval `{}` is already pending",
                request.approval_id
            ));
        }
        let (sender, receiver) = oneshot::channel();
        state.pending.insert(
            request.approval_id.clone(),
            PendingApproval { request, sender },
        );
        Ok(ApprovalRegistration::Pending(receiver))
    }

    pub(crate) fn resolve(
        &self,
        session_id: &str,
        approval_id: &str,
        decision: AgentApprovalDecision,
        scope: AgentApprovalScope,
        guidance: Option<String>,
        command_id: Option<String>,
    ) -> Result<NativeAgentApprovalAcknowledgement, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "native approval state lock is poisoned".to_string())?;
        let pending = state
            .pending
            .get(approval_id)
            .ok_or_else(|| format!("native approval `{approval_id}` is not pending"))?;
        if pending.request.session_id != session_id {
            return Err(format!(
                "native approval `{approval_id}` belongs to a different thread"
            ));
        }
        let pending = state
            .pending
            .remove(approval_id)
            .expect("pending approval was checked above");
        let resolution = NativeAgentApprovalResolution {
            approval_id: approval_id.to_string(),
            decision: decision.clone(),
            scope: scope.clone(),
            guidance,
            command_id: command_id.clone(),
        };
        pending.sender.send(resolution).map_err(|_| {
            format!("native approval `{approval_id}` tool future is no longer active")
        })?;
        if decision == AgentApprovalDecision::Approved && scope == AgentApprovalScope::Session {
            state
                .session_grants
                .insert((pending.request.session_id, pending.request.scope_key));
        }
        Ok(NativeAgentApprovalAcknowledgement {
            approval_id: approval_id.to_string(),
            decision,
            scope,
            command_id,
        })
    }

    pub(crate) fn cancel(&self, approval_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(approval_id);
        }
    }

    pub(crate) fn cancel_run(&self, turn_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .pending
                .retain(|_, pending| pending.request.turn_id != turn_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ApprovalRegistration, NativeAgentApprovalBroker, NativeAgentApprovalRequest};
    use crate::agent::runtime_protocol::{AgentApprovalDecision, AgentApprovalScope};

    fn request(approval_id: &str, session_id: &str, scope_key: &str) -> NativeAgentApprovalRequest {
        NativeAgentApprovalRequest {
            approval_id: approval_id.to_string(),
            session_id: session_id.to_string(),
            turn_id: "run-1".to_string(),
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
}
