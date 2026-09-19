# Tool Permissions
<!-- tinybot-module-fingerprint: sha256:d632a3814fa4c409359da7a4cbc64731083e6a6bc38f2e1053cdd01127e0ec7f -->

`permissions` evaluates whether a registered tool is allowed by the current
capability policy. It reports missing capabilities and normalizes the expected
filesystem, network, process, and session effects of a call.

`search_file_content` requires only `FsWorkspaceRead` and reports the requested
workspace-relative read scope, no writes, no network access, and no ambient
environment inheritance. The fixed bundled subprocess is an implementation
detail, not permission to execute arbitrary user commands.

`create_automation` reports a background mutation and requires the registry's
`AutomationWrite` (`automation.write`, scoped to `automation://definitions`)
and `SessionMetadataRead` capabilities.

An `apply_patch` with `thenRun` requires ShellExecute in addition to patch access
and reports Shell filesystem, network, and environment effects. A plain patch
retains its existing permission contract.

MCP calls use the configured-server scope, while MCP configuration mutation
uses its own `mcp://configuration` scope. Granting that scope does not grant
generic application configuration writes.
