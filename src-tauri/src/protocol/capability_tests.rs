use super::*;

#[test]
fn default_worker_policy_denies_sensitive_capabilities() {
    let policy = CapabilityPolicy::default();

    assert!(!policy.allows(&WorkerCapability::NetworkOpenAi));
    assert!(!policy.allows(&WorkerCapability::FsWorkspaceRead));
    assert!(!policy.allows(&WorkerCapability::SessionMetadataRead));
    assert!(!policy.allows(&WorkerCapability::ProviderSecretRead));
    assert!(!policy.allows(&WorkerCapability::FormRequest));
    assert!(!policy.allows(&WorkerCapability::TaskRead));
    assert!(!policy.allows(&WorkerCapability::TaskWrite));
    assert!(!policy.allows(&WorkerCapability::CronRead));
    assert!(!policy.allows(&WorkerCapability::CronWrite));
    assert!(!policy.allows(&WorkerCapability::CronRun));
    assert!(!policy.allows(&WorkerCapability::BackgroundRead));
    assert!(!policy.allows(&WorkerCapability::BackgroundWrite));
    assert!(!policy.allows(&WorkerCapability::McpCall));
    assert!(!policy.allows(&WorkerCapability::ShellExecute));
    assert!(!policy.allows(&WorkerCapability::BrowserObserve));
    assert!(!policy.allows(&WorkerCapability::BrowserInteract));
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
    let cases = [
        (WorkerCapability::NetworkOpenAi, "network.openai"),
        (WorkerCapability::FsWorkspaceRead, "fs.workspace.read"),
        (WorkerCapability::FsWorkspaceWrite, "fs.workspace.write"),
        (WorkerCapability::ConfigRead, "config.read"),
        (WorkerCapability::ConfigWrite, "config.write"),
        (WorkerCapability::ProviderSecretRead, "provider.secret.read"),
        (
            WorkerCapability::SessionMetadataRead,
            "session.metadata.read",
        ),
        (WorkerCapability::SessionWrite, "session.write"),
        (WorkerCapability::DiagnosticsWrite, "diagnostics.write"),
        (WorkerCapability::FormRequest, "form.request"),
        (WorkerCapability::TaskRead, "task.read"),
        (WorkerCapability::TaskWrite, "task.write"),
        (WorkerCapability::CronRead, "cron.read"),
        (WorkerCapability::CronWrite, "cron.write"),
        (WorkerCapability::CronRun, "cron.run"),
        (WorkerCapability::BackgroundRead, "background.read"),
        (WorkerCapability::BackgroundWrite, "background.write"),
        (WorkerCapability::McpCall, "mcp.call"),
        (WorkerCapability::ChannelConnector, "channel.connector"),
        (WorkerCapability::ShellExecute, "shell.execute"),
        (WorkerCapability::BrowserObserve, "browser.observe"),
        (WorkerCapability::BrowserInteract, "browser.interact"),
    ];

    for (capability, expected) in cases {
        assert_eq!(
            serde_json::to_value(capability).expect("capability should serialize"),
            serde_json::Value::String(expected.to_string())
        );
    }
}
