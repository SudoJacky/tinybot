# Shell Tools

`shell` runs workspace-scoped commands for agents and RPC clients. It validates
capabilities and working directories, then manages process input, output,
resize, polling, cancellation, and cleanup.

Agent-facing Shell results use the shared tool-outcome projection for states
that require a different next step. A retained process includes a structured
`write_stdin` continuation, while cancellation, timeout, non-zero exit,
process failure, and truncated output carry explicit retry guidance. Ordinary
successful commands keep the generic result projection.

Platform-specific process containment is implemented separately where needed.
