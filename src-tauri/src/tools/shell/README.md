# Shell Tools
<!-- tinybot-module-fingerprint: sha256:a8fd144ee79393f641e5a6b9c57e9b1a7c66c0b3ef2b7942a269f54fd90346e0 -->

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
On Windows, the Job Object helper is also reused by trusted subprocess runners
such as command hooks so closing the job terminates inherited descendants.
`WorkerShellRuntime` instances have independent process registries. The desktop
Sidecar uses its own instance for user-only interactive terminals, reuses the
PTY input/output implementation, and releases each terminal record immediately
after its resource is closed; Agent shell tools cannot address those processes.
