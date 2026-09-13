# Automation
<!-- tinybot-module-fingerprint: sha256:d77e1e9503c54ceb7646cff413cf3525ef463c48e85f031bdaffcee90f46bd8d -->

`automation` manages work that runs outside an active foreground turn.

- `background.rs` tracks background jobs and their events.
- `cron.rs` handles recurring schedules.
- `tasks.rs` stores and manages automation tasks.

## Saved workspace automations

`saved` owns reviewable definitions and immutable per-run definition/model
snapshots in the application data directory's `automations/store.json`.
Atomic writes and a process-wide transaction lock protect read/modify/write
operations. Definition edits and deletion require the expected revision;
deletion retains runs, canonical Threads, and workspace output files.
Definitions default to `modelPolicy: inherit_default`; explicit execution options
select a provider profile, an enabled model, and optional reasoning effort.
Each invocation records non-secret effective settings and retains its runtime
configuration for execution. Credentials are never written into history.

`execution` validates the workspace and local provider configuration before
claiming a manual run. A run creates an ordinary, parentless Thread or reuses the
selected unarchived, non-coordinator Thread in the same canonical workspace.
An active target Turn rejects without appending a new input. Each invocation
uses `execute_thread_turn_with_services` and has its own Turn ID. The desktop command
returns the run immediately; the backend owns execution across route changes.
The definition's instructions are the new user input, not a replayed transcript.
Thread origin metadata contains `automationId` and `automationRunId`.

Definitions, run metadata, and canonical Thread content are distinct authorities.
Report output is read from the owning Turn on demand; it is not copied into the
automation store. The renderer resolves report file links through guarded
Thread-scoped file reads. Text reports have paginated previews; other formats
remain available through the owning conversation's Artifact sidecar.

Only one running or waiting invocation is allowed per definition. Waiting runs
retain their owning Thread, and list reads reconcile subsequent completion from
that canonical Turn. On first access in a new process, previously running records
are persisted as interrupted and are never relaunched. The recorded finish time
for recovered runs is detection time, not an invented crash timestamp. Crashes
do not promise exactly-once external side effects. Execution failures, worker
panics, persistence errors, and restart recovery have correlated run-ID logs.

`schedule` computes once/daily/weekday/weekly occurrences in the desktop's local
timezone. On DST gaps it skips nonexistent occurrences; repeated local times
use the first occurrence. The desktop scheduler polls every five seconds after
runtime startup recovery. Closing a page or hiding the window does not stop it;
exiting the application does. Missed occurrences coalesce into one run on resume.
`Store::claim_due` atomically advances the next-run cursor and reserves the run;
subsequent preflight failures become visible failed history entries. Unchanged
schedules retain their cursor when edited, so a completed once-only task does not
rearm on rename. Manual frequency clears the cursor. Old persisted definitions
deserialize with manual execution and inherited models.

There are no notifications, budget controls, or Graph replay. See
[`saved_tests.rs`](saved_tests.rs) for persistence, non-overlap, workspace binding,
real file generation through the runtime, failure visibility, and restart checks;
the [manual walkthrough](../../../docs/guides/saved-automations.md) covers desktop use.
