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
