# Tool Permissions
<!-- tinybot-module-fingerprint: sha256:ae78671048ec6b8faefbde7068c25779965fdcfc11e34fe475bba40e2c501d30 -->

`permissions` evaluates whether a registered tool is allowed by the current
capability policy. It reports missing capabilities and normalizes the expected
filesystem, network, process, and session effects of a call.

MCP calls use the configured-server scope, while MCP configuration mutation
uses its own `mcp://configuration` scope. Granting that scope does not grant
generic application configuration writes.
