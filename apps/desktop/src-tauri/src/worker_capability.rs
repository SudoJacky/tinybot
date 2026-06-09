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
    #[serde(rename = "diagnostics.write")]
    DiagnosticsWrite,
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
}
