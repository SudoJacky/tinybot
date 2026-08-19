# Shell Tools
<!-- tinybot-module-fingerprint: sha256:74913b0a9d34422a318c10ee6d514be3f1708904b915b00f35d5734a10fbc8a3 -->

`shell` runs commands for agents and RPC clients in a validated working
directory. Relative paths resolve from the configured workspace; an existing
absolute directory outside it is also accepted when the active capability
policy permits execution. The module manages process input, output, resize,
polling, cancellation, and cleanup.

Agent-facing Shell results use the shared tool-outcome projection for states
that require a different next step. A retained process includes a structured
`write_stdin` continuation, while cancellation, timeout, non-zero exit,
process failure, and truncated output carry explicit retry guidance. Ordinary
successful commands keep the generic result projection.

Platform-specific process containment is implemented separately where needed.
`WorkerShellRuntime` instances have independent process registries. The desktop
Sidecar uses its own instance for user-only interactive terminals, reuses the
PTY input/output implementation, and releases each terminal record immediately
after its resource is closed; Agent shell tools cannot address those processes.
