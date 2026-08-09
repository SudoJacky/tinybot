# Worker Protocol

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.
