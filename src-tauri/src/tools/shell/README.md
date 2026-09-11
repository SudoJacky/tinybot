# Shell Tools
<!-- tinybot-module-fingerprint: sha256:d90bd4d019dc6ffd6bfe86b992187ea986fe4dd70a5bdf82de55f6be81b113bb -->

`shell` runs commands for agents and RPC clients in a validated working
directory. Relative paths resolve from the configured workspace; an existing
absolute directory outside it is also accepted when the active capability
policy permits execution. The module manages process input, output, resize,
polling, cancellation, and cleanup.

Shell startup separates preflight from process creation so Action Fusion can
validate the command, owner, capability, and working directory before applying
its patch. Startup rechecks cancellation after that patch and uses the same
owned process manager, output bounds, and continuation behavior as exec_command.

Agent-facing Shell results use the shared tool-outcome projection for states
that require a different next step. A retained process includes a structured
`write_stdin` continuation, while cancellation, timeout, non-zero exit,
process failure, and truncated output carry explicit retry guidance. Ordinary
successful commands keep the generic result projection.

Empty-input `write_stdin` waits for process completion, collecting progress in
the bounded transcript instead of returning on each log chunk. Its default
wait is 30 seconds, with a 5-second floor and a 300-second ceiling; completion
and cancellation wake the wait early. The deadline retains a running process.
Terminal and output waits recheck their monotonic deadline after every condition
variable wakeup, including platform timeout reports. Repeated deadline tests
cover early timer returns without launching subprocesses.
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
