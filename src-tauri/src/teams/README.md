# Team orchestration
<!-- tinybot-module-fingerprint: sha256:b16cb0ec0f80570759044b19955941e8db9afb5a0eda89f1bef0fdc008ab08ca -->

`teams` owns a shared task board and dependency scheduler for a fixed set of
members working toward one goal. It is independent of Agent Graphs and the
parent/child subagent manager. `desktop_commands::teams` supplies application
services and exposes the module to the main desktop window.

## Interface and ownership

- `plan` makes one tool-free provider request, parses strict JSON, and validates
  member assignments, dependencies, and the final task. Callers may instead
  supply a plan directly. Invalid output is an error, with no repair or fallback.
- `prepare` validates and snapshots the specification and plan in a new run.
- `get` and `list` return the durable board, including attempt histories,
  outputs, errors, revisions, and Thread/Turn IDs.
- `revise` replaces an idle, unfinished plan using an expected revision.
  Attempted tasks are immutable; unattempted tasks may be edited, reassigned,
  added, or removed. The final task must still depend transitively on all work.
- `execute` starts or resumes a planned/paused run and returns its final board.
  Its owned scheduler survives a dropped caller. Only one scheduler may own a
  run, with at most four active runs in this process.
- `control` requests pause/cancel or explicitly requeues named failed,
  cancelled, or interrupted tasks. Retry keeps prior attempts and results.

`TaskExecutor` is the execution seam. The native adapter creates a fresh Thread
for each task attempt, then delegates to the existing Thread/Turn bridge.
These Threads persist `source: team`. Their completed Turns do not generate
automatic long-term memory extractions; they still read the workspace's normal
creation-time memory snapshot. Old queued extractions are durably skipped.
`runtime` alone decides readiness and changes task state. `model` validates the
domain; `store` owns atomic snapshots, revision checks, and restart reconciliation.
The test executor controls completion and cancellation without a model service.

## Scheduling invariants

Plans contain 1–64 tasks and 1–8 members. The task graph is acyclic and every
task contributes to a designated final synthesis/review task. A task starts
only after every direct dependency succeeds. Its input contains the goal,
assigned task, and dependency message IDs with an aggregate bounded summary budget. Successful tasks
are never automatically rerun. Members receive separate task conversations;
this version has no persistent member chat or peer mailbox.

The configured limit (1–8) bounds concurrent Team tasks, and a member runs at
most one task at a time. Native workers inherit ordinary workspace capabilities,
including any existing subagent facilities; this is not a global bound on all
descendant agents. Members share the selected workspace. The planner assigns
file ownership in instructions, but the scheduler does not isolate files or
merge conflicting edits. Existing permissions and approvals remain enforced
by the native execution layer.

An attempt and its Thread/Turn identities are persisted before it can execute.
A result is persisted before downstream work can start. Task failure stops new
dispatch, cancels siblings, and drains their cleanup. Explicit cancellation
does the same. Pausing stops dispatch and lets active attempts finish; its
response can therefore still say `running` until draining completes. Poll
`get` for the resulting status. A worker cancelled through its own Thread also
stops the Team run. Missing or invalid completion messages are failures.

The native adapter requires a successful `team.complete_task` receipt. A Turn that yields for
human input is reported as a failed Team task with its Thread ID retained;
Team-level continuation/adoption of that Turn is not implemented. Inspect and
resolve the original Thread before explicitly retrying uncertain work. There
are no automatic quality scores, retries, member creation, or hidden replanning.

## Persistence and failure behavior

Runs live at `<application data>/team-runs/<run-id>.json` using atomic replacement.
The stored schema is version 3. State fields use snake case; object keys use
camel case. Commands that mutate a board require its current numeric revision.
Pause/cancel signals for active runs are process-local requests; only the
scheduler writes their resulting state. They do not acknowledge durable completion.

A process-wide lock serializes registry/store access; paths are canonicalized.
This is a single-process store, not a distributed job queue. Loading an orphaned
`running` run marks it and its running attempts `interrupted`. Completed outputs
remain intact. Recovery never silently replays a potentially side-effecting Turn.

Malformed stores, invalid plans, stale revisions, provider errors, and write
failures are returned explicitly. A write failure stops dispatch and drains all
in-flight attempts; the last durable snapshot is reconciled on the next read.
Lifecycle logs include run/task/member/Thread IDs, revisions, state changes, and
errors. They do not log prompts or credentials. Native Thread records retain
the detailed runtime/tool events.

## Validation

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib teams:: --jobs 2`.
Tests exercise dependency validation, parallel fan-out/fan-in, hard concurrency
limits, per-member exclusion, failure cleanup, explicit retry, pause/resume,
revision conflicts, interruption recovery, dropped callers, and native Thread
creation using the deterministic provider. No live provider credentials are needed.
See [Team API](../../../docs/api/teams.md) for invocation examples.

Schema version 2 requires human-readable member display names and task titles.
The planner emits titles in the goal language; native Thread titles use both
display fields. The store explicitly migrates version 1/2 snapshots once, using
version 1 IDs as initial labels, and logs the migration before persisting a revision.
New inputs remain strict and reject missing or blank labels.

## Shared messages

`board` owns the bounded completion contract, message discovery, and verified
artifact reads. `tools` contributes four tools only to active Team attempts and
rechecks saved Thread identity against the scheduler's current attempt. Model
arguments cannot choose a run or author. Reads are run-scoped; publication happens
only through scheduler completion, using its single atomic persistence owner.

Completion validates a short summary, unresolved issues, and workspace-relative
file references, then ends the native Turn without another provider call. The
scheduler assigns sequence/provenance and commits the message before downstream
work starts. Invalid tool submissions can be corrected; plain final responses
fail the task. Files carry byte size and SHA-256 identity; selected UTF-8 reads
verify both workspace authorization and unchanged content. See the Team API for
exact limits. Legacy full outputs stay inspectable but are handed off by ID.
