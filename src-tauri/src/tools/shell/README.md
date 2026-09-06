# Shell Tools
<!-- tinybot-module-fingerprint: sha256:39843feebcc46fdc46d3d83bfbf62d9b5a0932b8fee4697a85d3154578554116 -->

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

Empty-input `write_stdin` waits for process completion, collecting progress in
the bounded transcript instead of returning on each log chunk. Its default
wait is 30 seconds, with a 5-second floor and a 300-second ceiling; completion
and cancellation wake the wait early. The deadline retains a running process.
Non-empty input and `shell.poll` retain their responsive output waits, including
Sidecar terminal polling. Callers pass the latest cursor for incremental output.
Runtime metrics record `process.wait.durationMs`, `process.wait.stillRunning`,
`process.wait.finished`, and `process.wait.emptyOutput` to diagnose polling churn.

Platform-specific process containment is implemented separately where needed.
On Windows, the Job Object helper is also reused by trusted subprocess runners
such as command hooks so closing the job terminates inherited descendants.
`WorkerShellRuntime` instances have independent process registries. The desktop
Sidecar uses its own instance for user-only interactive terminals, reuses the
PTY input/output implementation, and releases each terminal record immediately
after its resource is closed; Agent shell tools cannot address those processes.
