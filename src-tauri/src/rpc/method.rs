#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerRpcNamespace {
    Approval,
    Background,
    Channel,
    Config,
    Cron,
    Diagnostics,
    Form,
    Mcp,
    Memory,
    PermissionProfile,
    Provider,
    Runtime,
    Session,
    Shell,
    Skills,
    Task,
    Thread,
    ToolExecutor,
    ToolRegistry,
    Workspace,
    Unknown,
}

impl WorkerRpcNamespace {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkerRpcNamespace::Approval => "approval",
            WorkerRpcNamespace::Background => "background",
            WorkerRpcNamespace::Channel => "channel",
            WorkerRpcNamespace::Config => "config",
            WorkerRpcNamespace::Cron => "cron",
            WorkerRpcNamespace::Diagnostics => "diagnostics",
            WorkerRpcNamespace::Form => "form",
            WorkerRpcNamespace::Mcp => "mcp",
            WorkerRpcNamespace::Memory => "memory",
            WorkerRpcNamespace::PermissionProfile => "permission_profile",
            WorkerRpcNamespace::Provider => "provider",
            WorkerRpcNamespace::Runtime => "runtime",
            WorkerRpcNamespace::Session => "session",
            WorkerRpcNamespace::Shell => "shell",
            WorkerRpcNamespace::Skills => "skills",
            WorkerRpcNamespace::Task => "task",
            WorkerRpcNamespace::Thread => "thread",
            WorkerRpcNamespace::ToolExecutor => "tool_executor",
            WorkerRpcNamespace::ToolRegistry => "tool_registry",
            WorkerRpcNamespace::Workspace => "workspace",
            WorkerRpcNamespace::Unknown => "unknown",
        }
    }
}

pub fn classify_method(method: &str) -> WorkerRpcNamespace {
    match method.split_once('.').map(|(namespace, _method)| namespace) {
        Some("approval") => WorkerRpcNamespace::Approval,
        Some("background") => WorkerRpcNamespace::Background,
        Some("channel") => WorkerRpcNamespace::Channel,
        Some("config") => WorkerRpcNamespace::Config,
        Some("cron") => WorkerRpcNamespace::Cron,
        Some("diagnostics") => WorkerRpcNamespace::Diagnostics,
        Some("form") => WorkerRpcNamespace::Form,
        Some("mcp") => WorkerRpcNamespace::Mcp,
        Some("memory") => WorkerRpcNamespace::Memory,
        Some("permission_profile") => WorkerRpcNamespace::PermissionProfile,
        Some("provider") => WorkerRpcNamespace::Provider,
        Some("runtime") => WorkerRpcNamespace::Runtime,
        Some("session") => WorkerRpcNamespace::Session,
        Some("shell") => WorkerRpcNamespace::Shell,
        Some("skills") => WorkerRpcNamespace::Skills,
        Some("task") => WorkerRpcNamespace::Task,
        Some("thread") => WorkerRpcNamespace::Thread,
        Some("tool_executor") => WorkerRpcNamespace::ToolExecutor,
        Some("tool_registry") => WorkerRpcNamespace::ToolRegistry,
        Some("workspace") => WorkerRpcNamespace::Workspace,
        _ => WorkerRpcNamespace::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_worker_rpc_namespaces() {
        assert_eq!(
            classify_method("workspace.read_file"),
            WorkerRpcNamespace::Workspace
        );
        assert_eq!(classify_method("memory.search"), WorkerRpcNamespace::Memory);
        assert_eq!(
            classify_method("permission_profile.current"),
            WorkerRpcNamespace::PermissionProfile
        );
        assert_eq!(
            classify_method("provider.resolve_secret"),
            WorkerRpcNamespace::Provider
        );
        assert_eq!(
            classify_method("thread.turn.list"),
            WorkerRpcNamespace::Thread
        );
        assert_eq!(classify_method("thread.list"), WorkerRpcNamespace::Thread);
        assert_eq!(classify_method("shell.start"), WorkerRpcNamespace::Shell);
        assert_eq!(
            classify_method("tool_executor.execute"),
            WorkerRpcNamespace::ToolExecutor
        );
        assert_eq!(
            classify_method("tool_registry.list"),
            WorkerRpcNamespace::ToolRegistry
        );
        assert_eq!(classify_method("unknown"), WorkerRpcNamespace::Unknown);
    }
}
