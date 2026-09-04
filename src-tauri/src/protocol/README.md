# Worker Protocol
<!-- tinybot-module-fingerprint: sha256:9f474631d6f99c55fdbb83164c55058b1181c13c3b1b698947ef5fe021ff9b91 -->

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.

The `mcp.config.write` capability is intentionally distinct from generic
`config.write`: it authorizes only registered MCP domain tools, not arbitrary
application configuration mutation.
