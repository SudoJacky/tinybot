# Worker Protocol
<!-- tinybot-module-fingerprint: sha256:78be57bd236795f0b4248a2e47d5029df013cb7454e7e81695944e46b495565f -->

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.
