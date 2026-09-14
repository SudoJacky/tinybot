# Tool Permissions
<!-- tinybot-module-fingerprint: sha256:03b01d99ad5679fc30a7ec9ac09830475dde078ab6db33dd0cb90b15aecbc779 -->

`permissions` evaluates whether a registered tool is allowed by the current
capability policy. It reports missing capabilities and normalizes the expected
filesystem, network, process, and session effects of a call.

`create_automation` reports a background mutation and requires the registry's
`CronWrite` and `SessionMetadataRead` capabilities.

An `apply_patch` with `thenRun` requires ShellExecute in addition to patch access
and reports Shell filesystem, network, and environment effects. A plain patch
retains its existing permission contract.

MCP calls use the configured-server scope, while MCP configuration mutation
uses its own `mcp://configuration` scope. Granting that scope does not grant
generic application configuration writes.
