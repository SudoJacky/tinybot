# Native Runtime Services
<!-- tinybot-module-fingerprint: sha256:002e786ab7acb7d249963907899ab33789fb8d5aadbf5b8730fe4fce5a401ff5 -->

`runtime` owns process-local services that must outlive an individual backend
request: turn execution ownership, shared MCP connections, startup/shutdown
lifecycle, and bounded operational metrics.

These modules are crate-internal. Public commands reach them through the
desktop or Worker RPC boundaries.

## Components

- `turn_execution.rs`: ownership and state for active, waiting, draining,
  cancelled, and terminal agent turns.
- `mcp.rs`: shared MCP server connections, discovered tools, status, and
  reconciliation.
- `lifecycle.rs`: startup consistency checks/recovery and coordinated shutdown.
- `observability.rs`: process-local, secret-safe runtime counters and snapshots.
  Duration aggregates retain a separate 300-entry timing ring with wall-clock
  boundaries and eviction counts. `measure` preserves the operation's error and
  records completed/failed outcomes. Startup recovery times initial loading,
  index preparation/validation, thread/turn scans and any required reload; the
  total includes all recovery work before completion. Clean recovery reuses the
  initialized projection and the preparation's consistency report. Index repair
  refreshes that projection before scanning; interrupted-turn writes trigger a
  final reload. A no-write recovery increments `recovery.projection.reload.skipped`.
- `working_directory.rs`: validation and canonicalization of requested working
  directories.

## Agent task ownership

`TurnExecutionRuntime` is the authority for live turn execution. A turn has a
generation, cancellation token, completion state, and a single owned execution
handle. Replacing or terminating a generation moves old work to draining state
so late results cannot become the current terminal result.

Owned completions retain `Result<AgentTurnResult, String>` without a JSON
round trip. `AgentStopReason` determines terminal versus waiting state;
`awaiting_tool`, `tool_running`, and `awaiting_subagent` preserve the resume
token and allow another generation under the same Turn identity.

Callers should use this service for cancellation rather than maintaining a
parallel map of spawned tasks.

## Startup and shutdown

Startup reconciliation runs before the runtime accepts new agent work. It:

1. Prepares and verifies the derived Rollout state index, applying only its
   named missing-index migration when needed.
2. Rebuilds the typed in-memory Thread projection from canonical Rollouts.
3. Reconciles active Thread and persisted turn records, marking orphaned work
   interrupted while preserving resumable waiting turns.
4. Records a queryable recovery report or a visible startup failure.

Shutdown stops accepting new work, requests cancellation, drains owned agent
tasks, cleans up shell processes, MCP connections, and subagents, then flushes
or shuts down Thread persistence. All stage failures remain in the lifecycle
report.

## Invariants

- New work is not accepted before startup reconciliation succeeds or while
  shutdown is in progress.
- At most one current generation owns the terminal result for a turn ID.
- Cancellation is cooperative; state changes remain observable while the task
  reaches a safe boundary.
- Late results from replaced or cancelled generations cannot overwrite the
  current turn outcome.
- MCP state is shared across requests and agent turns; do not create a new MCP
  runtime per operation.
- Lifecycle failures are accumulated as bounded diagnostics, not swallowed.
- Metrics must remain bounded and must not contain prompts, secrets, tool
  output, or private workspace payloads.
- Persistence repair is explicit. Startup may apply named legacy migrations,
  but unexpected divergence is a startup failure.

See the [backend overview](../../README.md) for layer ownership and the
[desktop command reference](../../../docs/api/desktop.md) for exposed
lifecycle and metrics shapes.
