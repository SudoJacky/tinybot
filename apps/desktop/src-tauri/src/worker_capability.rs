use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
pub enum WorkerCapability {
    #[serde(rename = "network.openai")]
    NetworkOpenAi,
    #[serde(rename = "fs.workspace.read")]
    FsWorkspaceRead,
    #[serde(rename = "fs.workspace.write")]
    FsWorkspaceWrite,
    #[serde(rename = "config.read")]
    ConfigRead,
    #[serde(rename = "config.write")]
    ConfigWrite,
    #[serde(rename = "provider.secret.read")]
    ProviderSecretRead,
    #[serde(rename = "session.metadata.read")]
    SessionMetadataRead,
    #[serde(rename = "session.write")]
    SessionWrite,
    #[serde(rename = "diagnostics.write")]
    DiagnosticsWrite,
    #[serde(rename = "approval.request")]
    ApprovalRequest,
    #[serde(rename = "approval.resolve")]
    ApprovalResolve,
    #[serde(rename = "form.request")]
    FormRequest,
    #[serde(rename = "memory.read")]
    MemoryRead,
    #[serde(rename = "memory.write")]
    MemoryWrite,
    #[serde(rename = "knowledge.read")]
    KnowledgeRead,
    #[serde(rename = "knowledge.write")]
    KnowledgeWrite,
    #[serde(rename = "task.read")]
    TaskRead,
    #[serde(rename = "task.write")]
    TaskWrite,
    #[serde(rename = "cron.read")]
    CronRead,
    #[serde(rename = "cron.write")]
    CronWrite,
    #[serde(rename = "cron.run")]
    CronRun,
    #[serde(rename = "background.read")]
    BackgroundRead,
    #[serde(rename = "background.write")]
    BackgroundWrite,
    #[serde(rename = "mcp.call")]
    McpCall,
    #[serde(rename = "channel.connector")]
    ChannelConnector,
    #[serde(rename = "shell.execute")]
    ShellExecute,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityGrant {
    pub capability: WorkerCapability,
    pub scope: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Default, Deserialize, Serialize)]
pub struct CapabilityPolicy {
    grants: BTreeSet<WorkerCapability>,
}

impl CapabilityPolicy {
    pub fn new(capabilities: impl IntoIterator<Item = WorkerCapability>) -> Self {
        Self {
            grants: capabilities.into_iter().collect(),
        }
    }

    pub fn allows(&self, capability: &WorkerCapability) -> bool {
        self.grants.contains(capability)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_worker_policy_denies_sensitive_capabilities() {
        let policy = CapabilityPolicy::default();

        assert!(!policy.allows(&WorkerCapability::NetworkOpenAi));
        assert!(!policy.allows(&WorkerCapability::FsWorkspaceRead));
        assert!(!policy.allows(&WorkerCapability::SessionMetadataRead));
        assert!(!policy.allows(&WorkerCapability::ProviderSecretRead));
        assert!(!policy.allows(&WorkerCapability::ApprovalRequest));
        assert!(!policy.allows(&WorkerCapability::ApprovalResolve));
        assert!(!policy.allows(&WorkerCapability::FormRequest));
        assert!(!policy.allows(&WorkerCapability::MemoryRead));
        assert!(!policy.allows(&WorkerCapability::MemoryWrite));
        assert!(!policy.allows(&WorkerCapability::TaskRead));
        assert!(!policy.allows(&WorkerCapability::TaskWrite));
        assert!(!policy.allows(&WorkerCapability::CronRead));
        assert!(!policy.allows(&WorkerCapability::CronWrite));
        assert!(!policy.allows(&WorkerCapability::CronRun));
        assert!(!policy.allows(&WorkerCapability::BackgroundRead));
        assert!(!policy.allows(&WorkerCapability::BackgroundWrite));
        assert!(!policy.allows(&WorkerCapability::McpCall));
        assert!(!policy.allows(&WorkerCapability::ShellExecute));
    }

    #[test]
    fn explicit_policy_grants_only_named_capabilities() {
        let policy = CapabilityPolicy::new([
            WorkerCapability::NetworkOpenAi,
            WorkerCapability::DiagnosticsWrite,
        ]);

        assert!(policy.allows(&WorkerCapability::NetworkOpenAi));
        assert!(policy.allows(&WorkerCapability::DiagnosticsWrite));
        assert!(!policy.allows(&WorkerCapability::FsWorkspaceWrite));
        assert!(!policy.allows(&WorkerCapability::ShellExecute));
    }

    #[test]
    fn capability_names_serialize_as_protocol_strings() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::FsWorkspaceRead,
            scope: "workspace://current".to_string(),
        };

        let value = serde_json::to_value(grant).expect("grant should serialize");

        assert_eq!(
            value,
            json!({
                "capability": "fs.workspace.read",
                "scope": "workspace://current"
            })
        );
    }

    #[test]
    fn form_request_capability_name_serializes_as_protocol_string() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::FormRequest,
            scope: "agent-ui://current".to_string(),
        };

        let value = serde_json::to_value(grant).expect("grant should serialize");

        assert_eq!(
            value,
            json!({
                "capability": "form.request",
                "scope": "agent-ui://current"
            })
        );
    }

    #[test]
    fn approval_request_capability_name_serializes_as_protocol_string() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::ApprovalRequest,
            scope: "approval://current".to_string(),
        };

        let value = serde_json::to_value(grant).expect("grant should serialize");

        assert_eq!(
            value,
            json!({
                "capability": "approval.request",
                "scope": "approval://current"
            })
        );
    }

    #[test]
    fn approval_resolve_capability_name_serializes_as_protocol_string() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::ApprovalResolve,
            scope: "approval://current".to_string(),
        };

        let value = serde_json::to_value(grant).expect("grant should serialize");

        assert_eq!(
            value,
            json!({
                "capability": "approval.resolve",
                "scope": "approval://current"
            })
        );
    }

    #[test]
    fn memory_capability_names_serialize_as_protocol_strings() {
        let read_grant = CapabilityGrant {
            capability: WorkerCapability::MemoryRead,
            scope: "memory://notes".to_string(),
        };
        let write_grant = CapabilityGrant {
            capability: WorkerCapability::MemoryWrite,
            scope: "memory://notes".to_string(),
        };

        assert_eq!(
            serde_json::to_value(read_grant).expect("grant should serialize"),
            json!({
                "capability": "memory.read",
                "scope": "memory://notes"
            })
        );
        assert_eq!(
            serde_json::to_value(write_grant).expect("grant should serialize"),
            json!({
                "capability": "memory.write",
                "scope": "memory://notes"
            })
        );
    }

    #[test]
    fn background_capability_names_serialize_as_protocol_strings() {
        let read = CapabilityGrant {
            capability: WorkerCapability::BackgroundRead,
            scope: "background://registry".to_string(),
        };
        let write = CapabilityGrant {
            capability: WorkerCapability::BackgroundWrite,
            scope: "background://registry".to_string(),
        };

        assert_eq!(
            serde_json::to_value(read).expect("grant should serialize"),
            json!({
                "capability": "background.read",
                "scope": "background://registry"
            })
        );
        assert_eq!(
            serde_json::to_value(write).expect("grant should serialize"),
            json!({
                "capability": "background.write",
                "scope": "background://registry"
            })
        );
    }

    #[test]
    fn knowledge_capability_names_serialize_as_protocol_strings() {
        let read_grant = CapabilityGrant {
            capability: WorkerCapability::KnowledgeRead,
            scope: "knowledge://workspace".to_string(),
        };
        let write_grant = CapabilityGrant {
            capability: WorkerCapability::KnowledgeWrite,
            scope: "knowledge://workspace".to_string(),
        };

        assert_eq!(
            serde_json::to_value(read_grant).expect("grant should serialize"),
            json!({
                "capability": "knowledge.read",
                "scope": "knowledge://workspace"
            })
        );
        assert_eq!(
            serde_json::to_value(write_grant).expect("grant should serialize"),
            json!({
                "capability": "knowledge.write",
                "scope": "knowledge://workspace"
            })
        );
    }

    #[test]
    fn task_capability_names_serialize_as_protocol_strings() {
        let read_grant = CapabilityGrant {
            capability: WorkerCapability::TaskRead,
            scope: "task://plans".to_string(),
        };
        let write_grant = CapabilityGrant {
            capability: WorkerCapability::TaskWrite,
            scope: "task://plans".to_string(),
        };

        assert_eq!(
            serde_json::to_value(read_grant).expect("grant should serialize"),
            json!({
                "capability": "task.read",
                "scope": "task://plans"
            })
        );
        assert_eq!(
            serde_json::to_value(write_grant).expect("grant should serialize"),
            json!({
                "capability": "task.write",
                "scope": "task://plans"
            })
        );
    }

    #[test]
    fn cron_capability_names_serialize_as_protocol_strings() {
        let read_grant = CapabilityGrant {
            capability: WorkerCapability::CronRead,
            scope: "cron://jobs".to_string(),
        };
        let write_grant = CapabilityGrant {
            capability: WorkerCapability::CronWrite,
            scope: "cron://jobs".to_string(),
        };
        let run_grant = CapabilityGrant {
            capability: WorkerCapability::CronRun,
            scope: "cron://jobs".to_string(),
        };

        assert_eq!(
            serde_json::to_value(read_grant).expect("grant should serialize"),
            json!({
                "capability": "cron.read",
                "scope": "cron://jobs"
            })
        );
        assert_eq!(
            serde_json::to_value(write_grant).expect("grant should serialize"),
            json!({
                "capability": "cron.write",
                "scope": "cron://jobs"
            })
        );
        assert_eq!(
            serde_json::to_value(run_grant).expect("grant should serialize"),
            json!({
                "capability": "cron.run",
                "scope": "cron://jobs"
            })
        );
    }

    #[test]
    fn mcp_call_capability_name_serializes_as_protocol_string() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::McpCall,
            scope: "mcp://configured".to_string(),
        };

        assert_eq!(
            serde_json::to_value(grant).expect("grant should serialize"),
            json!({
                "capability": "mcp.call",
                "scope": "mcp://configured"
            })
        );
    }

    #[test]
    fn provider_secret_read_capability_name_serializes_as_protocol_string() {
        let grant = CapabilityGrant {
            capability: WorkerCapability::ProviderSecretRead,
            scope: "provider://runtime".to_string(),
        };

        assert_eq!(
            serde_json::to_value(grant).expect("grant should serialize"),
            json!({
                "capability": "provider.secret.read",
                "scope": "provider://runtime"
            })
        );
    }
}
