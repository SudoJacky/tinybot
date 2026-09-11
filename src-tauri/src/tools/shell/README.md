# Shell Tools
<!-- tinybot-module-fingerprint: sha256:10fc13c0c9ee955355f59aaa75b27a3a3a7a1b65117c3a6c35059ebd17269771 -->

`shell` runs commands for agents and RPC clients in a validated working
directory. Relative paths resolve from the configured workspace; an existing
absolute directory outside it is also accepted when the active capability
policy permits execution. The module manages process input, output, resize,
polling, cancellation, and cleanup.

Shell startup separates request preflight from filesystem resolution. Action
Fusion validates the command, owner, capability, path syntax, and cancellation
before editing. Startup rechecks cancellation and resolves the existing directory
after the patch, allowing the patch to create it. Directory failures include the
requested path, workspace root, and resolution stage. The owned process manager,
output bounds, and continuation behavior remain shared with exec_command.

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
