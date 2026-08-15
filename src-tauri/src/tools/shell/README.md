# Shell Tools
<!-- tinybot-module-fingerprint: sha256:00897e4f2d30f5bd68093656adfe1664689c55847f15c8396471ca99d467d436 -->

`shell` runs workspace-scoped commands for agents and RPC clients. It validates
capabilities and working directories, then manages process input, output,
resize, polling, cancellation, and cleanup.

Agent-facing Shell results use the shared tool-outcome projection for states
that require a different next step. A retained process includes a structured
`write_stdin` continuation, while cancellation, timeout, non-zero exit,
process failure, and truncated output carry explicit retry guidance. Ordinary
successful commands keep the generic result projection.

Platform-specific process containment is implemented separately where needed.
