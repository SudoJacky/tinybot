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

    pub(crate) fn cancel_turn(&self, turn_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .pending
                .retain(|_, pending| pending.request.turn_id != turn_id);
        }
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
