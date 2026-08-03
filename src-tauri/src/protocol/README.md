# Worker Protocol

`protocol` defines the versioned request, response, event, and error envelopes
used by worker transports and the RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Transport and domain implementations should depend on these shared types
rather than defining parallel wire formats.
