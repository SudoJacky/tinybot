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
    #[serde(rename = "browser.observe")]
    BrowserObserve,
    #[serde(rename = "browser.interact")]
    BrowserInteract,
}

#[cfg(test)]
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

    pub fn granted_capabilities(&self) -> Vec<WorkerCapability> {
        self.grants.iter().cloned().collect()
    }
}

pub fn default_desktop_capability_policy() -> CapabilityPolicy {
    let capabilities = vec![
        WorkerCapability::ConfigRead,
        WorkerCapability::ProviderSecretRead,
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::FsWorkspaceWrite,
        WorkerCapability::ShellExecute,
        WorkerCapability::DiagnosticsWrite,
        WorkerCapability::ApprovalRequest,
        WorkerCapability::ApprovalResolve,
        WorkerCapability::FormRequest,
        WorkerCapability::MemoryRead,
        WorkerCapability::MemoryWrite,
        WorkerCapability::CronRead,
        WorkerCapability::CronWrite,
        WorkerCapability::CronRun,
        WorkerCapability::BackgroundRead,
        WorkerCapability::BackgroundWrite,
        WorkerCapability::TaskRead,
        WorkerCapability::TaskWrite,
        WorkerCapability::McpCall,
        WorkerCapability::ChannelConnector,
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ];
    #[cfg(all(windows, feature = "native-browser-runtime"))]
    let capabilities = capabilities
        .into_iter()
        .chain([
            WorkerCapability::BrowserObserve,
            WorkerCapability::BrowserInteract,
        ])
        .collect::<Vec<_>>();
    CapabilityPolicy::new(capabilities)
}

#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
