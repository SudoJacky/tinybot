# Worker Protocol
<!-- tinybot-module-fingerprint: sha256:6f753af2a8929b4ffca80ff0e9265ec9c4f7a4ab22a721c6e5ab42aa1bff2e89 -->

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.
