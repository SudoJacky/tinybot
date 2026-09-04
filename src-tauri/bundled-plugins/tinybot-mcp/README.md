# Tinybot MCP
<!-- tinybot-module-fingerprint: sha256:5a41895cc1429e5a956dc1a8b2c25b3a43d7fd52edfddaee22b2d5be4518d26e -->

Tinybot's built-in guidance for configuring global MCP servers from a URL or installation instructions.

The `configure-mcp` Skill uses Tinybot's restricted MCP configuration tools. Those tools expose only credential-redacted MCP settings and typed stdio or Streamable HTTP updates; they do not expose generic configuration writes.

Literal credentials must be entered by the user on the **Tools & Plugins → MCP** page. Agent-driven configuration uses environment-variable references so secrets do not enter conversation or tool-call history.
