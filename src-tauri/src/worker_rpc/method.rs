#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerRpcNamespace {
    Approval,
    Background,
    Channel,
    Config,
    Cron,
    Diagnostics,
    Form,
    Knowledge,
    Mcp,
    Memory,
    Provider,
    Runtime,
    Session,
    Skills,
    Task,
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
            WorkerRpcNamespace::Knowledge => "knowledge",
            WorkerRpcNamespace::Mcp => "mcp",
            WorkerRpcNamespace::Memory => "memory",
            WorkerRpcNamespace::Provider => "provider",
            WorkerRpcNamespace::Runtime => "runtime",
            WorkerRpcNamespace::Session => "session",
            WorkerRpcNamespace::Skills => "skills",
            WorkerRpcNamespace::Task => "task",
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
        Some("knowledge") => WorkerRpcNamespace::Knowledge,
        Some("mcp") => WorkerRpcNamespace::Mcp,
        Some("memory") => WorkerRpcNamespace::Memory,
        Some("provider") => WorkerRpcNamespace::Provider,
        Some("runtime") => WorkerRpcNamespace::Runtime,
        Some("session") => WorkerRpcNamespace::Session,
        Some("skills") => WorkerRpcNamespace::Skills,
        Some("task") => WorkerRpcNamespace::Task,
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
            classify_method("provider.resolve_secret"),
            WorkerRpcNamespace::Provider
        );
        assert_eq!(classify_method("unknown"), WorkerRpcNamespace::Unknown);
    }
}
