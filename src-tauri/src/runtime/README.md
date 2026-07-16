# Native Runtime Services

`runtime` owns process-local services that must outlive an individual backend
request: agent task ownership, shared MCP connections, startup/shutdown
lifecycle, and bounded operational metrics.

These modules are crate-internal. Public commands reach them through the
desktop or Worker RPC boundaries.

## Components

- `agent_task.rs`: ownership and state for active, paused, draining, cancelled,
  and terminal agent runs.
- `mcp.rs`: shared MCP server connections, discovered tools, status, and
  reconciliation.
- `lifecycle.rs`: startup consistency checks/recovery and coordinated shutdown.
- `observability.rs`: process-local, secret-safe runtime counters and snapshots.

## Agent task ownership

`AgentTaskRuntime` is the authority for live run execution. A run has a
generation, cancellation token, pause control, completion state, and a single
owned execution handle. Replacing or terminating a generation moves old work
to draining state so late results cannot become the current terminal result.

Callers should use this service for cancellation and pause/resume rather than
maintaining a parallel map of spawned tasks.

## Startup and shutdown

Startup reconciliation runs before the runtime accepts new agent work. It:

1. Checks typed Thread journal/projection consistency and performs only the
   named legacy migration when applicable.
2. Checks the session-compatible log index and performs its named missing-index
   migration when applicable.
3. Reconciles persisted run records, marking orphaned active runs interrupted
   while preserving resumable waiting runs.
4. Records a queryable recovery report or a visible startup failure.

Shutdown stops accepting new work, requests cancellation, drains owned agent
tasks, cleans up shell processes, MCP connections, subagents, and background
workers, and records all stage failures in the lifecycle report.

## Invariants

- New work is not accepted before startup reconciliation succeeds or while
  shutdown is in progress.
- At most one current generation owns the terminal result for a run ID.
- Cancellation and pause are cooperative; state changes remain observable
  while the task reaches a safe boundary.
- Late results from replaced or cancelled generations cannot overwrite the
  current run outcome.
- MCP state is shared across requests and agent turns; do not create a new MCP
  runtime per operation.
- Lifecycle failures are accumulated as bounded diagnostics, not swallowed.
- Metrics must remain bounded and must not contain prompts, secrets, tool
  output, or private workspace payloads.
- Persistence repair is explicit. Startup may apply named legacy migrations,
  but unexpected divergence is a startup failure.

See the [backend overview](../../README.md) for layer ownership and the
[API reference](../../../docs/api/rust-backend-api.md) for exposed lifecycle
and metrics shapes.
