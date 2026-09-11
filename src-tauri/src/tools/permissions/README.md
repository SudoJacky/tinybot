# Tool Permissions
<!-- tinybot-module-fingerprint: sha256:b7423de69329a4c42534c3778aec0145875ef3b857463b2e45a1d4e367fafe68 -->

`permissions` evaluates whether a registered tool is allowed by the current
capability policy. It reports missing capabilities and normalizes the expected
filesystem, network, process, and session effects of a call.

An `apply_patch` with `thenRun` requires ShellExecute in addition to patch access
and reports Shell filesystem, network, and environment effects. A plain patch
retains its existing permission contract.

MCP calls use the configured-server scope, while MCP configuration mutation
uses its own `mcp://configuration` scope. Granting that scope does not grant
generic application configuration writes.
