# Worker Protocol
<!-- tinybot-module-fingerprint: sha256:557c81cd277b3ab04abfcde60e32713aa2a44ec9277b2aa1fe4fd614bd2bd903 -->

`protocol` defines the versioned request, response, and error envelopes used by
the in-process RPC router.

It also owns request IDs, typed parameter parsing, and capability policies.
Domain implementations should depend on these shared types rather than
defining parallel wire formats.
