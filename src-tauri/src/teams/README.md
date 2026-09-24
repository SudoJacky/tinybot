# Team orchestration
<!-- tinybot-module-fingerprint: sha256:142cfa6021cf492ffa340c1b4b913d4180398c34c3ec14659ebc644183330193 -->

The command allocates the run ID before invoking the planner and passes it to
`prepare_with_id`; planner usage therefore shares the eventual board identity.
Task and descendant usage resolves persisted attempt Thread ancestry. The shared
usage ledger owns accounting; the board does not store independent token totals.

`teams` owns a shared task board and dependency scheduler for dynamically recruited or configured
members working toward one goal. It is independent of Agent Graphs and the
parent/child subagent manager. `desktop_commands::teams` supplies application
services and exposes the module to the main desktop window.

## Interface and ownership

- `plan` makes one tool-free provider request, parses strict JSON, and validates
  member assignments, dependencies, and the final task. Assignments follow each
  member's configured responsibilities and specify downstream deliverables and
  evidence. Chat coordination and the standalone planner both compile in
  [assignment guidance](assignment_guidance.md): tasks state their outcome,
  scope, deliverable, evidence requirements, completion criteria and stopping
  conditions inside the existing instructions string. This baseline does not
  depend on optional skill activation. Callers may instead
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

Plans contain 1–64 tasks and 1–64 members. The task graph is acyclic. Standalone plans designate a final synthesis/review
task; Chat plans leave finalTaskId empty and the parent integrates leaf results. A task starts
only after every direct dependency succeeds. Its input contains the goal,
assigned task, the saved team roster (member IDs, display names and responsibilities),
and dependency message IDs with complete handoff text and artifact references. Successful tasks
are never automatically rerun. Members receive separate task conversations;
this version has no persistent member chat or peer mailbox.

The native adapter supplies the acting member's identity and role instructions
through `agentRole`, with shared collaboration and completion guidance. Other
members' responsibilities remain roster context in the task input, not additional
instructions for the acting member. IDs determine identity even when display
names repeat. The native execution test checks these boundaries at the provider.

Employees check the assignment's completion criteria before handoff, stop when
they are met, and report unmet criteria and their impact through unresolved.
The coordinator assesses those criteria again during integration. These are
model instructions, not an automatic evidence-quality validator; successful
publication alone does not certify that the requested outcome was achieved.

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
are no automatic quality scores, retries, or hidden replanning. Chat recruitment
is explicit through coordinator tools.

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
Native execution covers Chat Completions and Responses, including completion
summary reload and dependent task release without an extra provider call.
See [Team API](../../../docs/api/teams.md) for invocation examples.

Schema version 2 requires human-readable member display names and task titles.
The planner emits titles in the goal language; native Thread titles use both
display fields. The store explicitly migrates version 1/2 snapshots once, using
version 1 IDs as initial labels, and logs the migration before persisting a revision.
New inputs remain strict and reject missing or blank labels.

## Shared messages

`board` owns the completion contract, message discovery, and verified
artifact reads. `tools` contributes four tools only to active Team attempts and
rechecks saved Thread identity against the scheduler's current attempt. Model
arguments cannot choose a run or author. Reads are run-scoped; publication happens
only through scheduler completion, using its single atomic persistence owner.

Completion validates a nonblank summary, unresolved issues, and workspace-relative
file references, then ends the native Turn without another provider call. The
scheduler assigns sequence/provenance and commits the message before downstream
work starts. Invalid tool submissions can be corrected; plain final responses
fail the task. Files carry byte size and SHA-256 identity; selected UTF-8 reads
verify both workspace authorization and unchanged content. See the Team API for
artifact limits. Summary and unresolved text have no size limits. Notifications
and dependency inputs carry complete summaries, unresolved issues and artifact
references; file bodies stay lazy. Legacy outputs remain inspectable by ID.

## Chat coordination and isolated conversations

An explicit `@team` in user input enables coordinator tools for that ordinary
workspace conversation. `team.recruit` supplies named members, detailed roles and
DAG tasks. It starts background work or appends validated, immutable assignments
through the scheduler queue. Existing members and attempted tasks cannot be
rewritten. Completed Chat runs can accept additional work. Only the saved parent
Thread can inspect/control the run through model tools.

`team.wait` subscribes to committed state changes without empty timeout responses.
It waits for `next_result` (default) or `all_tasks`, returning on a matching result,
failure or non-running state. Up to eight complete handoffs accompany the sequence
cursor; use `team.inspect` to drain additional pages. Cancellation interrupts the
wait. Progress-only notifications stay inside the runtime, and UI reads remain
independent. It continues the existing parent turn; it never creates competing
parent turns. `team.read_result` reads complete messages or verified artifact ranges. Parent
cancellation propagates to runs started by that turn. Workers inherit model,
provider and tool selection, but do not receive coordinator tools.

Run JSON stays at `team-runs/<run-id>.json`. Attempt conversations live under
`team-runs/<run-id>/conversations/`, with separate indexes, caches and lifecycle
locks. Application configuration, workspace memory and accounting roots remain
shared. Worker tracing is rebound to the isolated store. Ordinary lists and
startup projection scans never include these logs. Known attempt reads resolve
the saved run directly; a one-time startup migration relocates older Team logs
and their descendants before opening recorders.

Bridge integration tests exercise Chat Completions and Responses through a form
pause, changed application defaults, recruitment, native worker execution,
committed handoff and parent integration. They verify file writes stay in the
selected workspace and worker histories stay outside the ordinary Thread list.
