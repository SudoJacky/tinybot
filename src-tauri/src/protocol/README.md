# Worker Protocol
<!-- tinybot-module-fingerprint: sha256:23877545ecb5116439fed11074dbb6f6b04beb56f1b04677ccb998aef918d646 -->

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.

The `mcp.config.write` capability is intentionally distinct from generic
`config.write`: it authorizes only registered MCP domain tools, not arbitrary
application configuration mutation.

`automation.write` authorizes saved automation creation. Desktop policies grant
it explicitly; it replaces the retired workspace cron capabilities.
