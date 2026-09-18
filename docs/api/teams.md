# Team API
<!-- tinybot-doc-watch:
src-tauri/src/desktop_commands/teams.rs
src-tauri/src/teams/board.rs
src-tauri/src/teams/tools.rs
src-tauri/src/teams/native.rs
src-tauri/src/teams/model.rs
src-tauri/src/teams/mod.rs
src-tauri/src/teams/runtime.rs
src-tauri/src/teams/store.rs
src/app-core/native/desktopNativeTeams.ts
-->
<!-- tinybot-doc-fingerprint: sha256:03da07b70a6272af26a531ba50455bc981363733aa91f3e31816834fe5e0682b -->

Team commands are available to the main desktop window. They return a `TeamRun`
object or reject with an error string. The independent Teams route uses the typed renderer adapter to prepare a plan,
confirm assignments, execute work, and inspect results and attempt Threads.

| Command | Arguments | Result |
| --- | --- | --- |
| `worker_team_prepare` | `{ input: { spec, plan?, plannerModel? } }` | New planned run |
| `worker_team_runs_list` | None | All runs, newest first |
| `worker_team_artifact_read` | `{ runId, input: { entryId, artifactIndex, byteOffset?, maxBytes? } }` | Verified UTF-8 artifact page |
| `worker_team_run_get` | `{ runId }` | Current board; reconciles interrupted execution |
| `worker_team_revise` | `{ input: { runId, expectedRevision, plan } }` | Revised idle board |
| `worker_team_execute` | `{ input: { runId, expectedRevision } }` | Run after execution stops |
| `worker_team_control` | `{ input: { runId, expectedRevision, action, taskIds? } }` | Current board or updated idle board |

## Prepare and execute

```ts
const run = await invoke("worker_team_prepare", {
  input: {
    spec: {
      goal: "Compare the two implementation options and write a recommendation",
      workspacePath: "D:/projects/example",
      maxConcurrency: 2,
      members: [
        { id: "researcher", displayName: "Researcher", instructions: "Collect source-backed evidence" },
        { id: "reviewer", displayName: "Reviewer", instructions: "Check claims and synthesize tradeoffs" },
      ],
    },
    plan: {
      tasks: [
        { id: "option-a", title: "Investigate option A", memberId: "researcher", instructions: "Investigate option A", dependencies: [] },
        { id: "option-b", title: "Investigate option B", memberId: "reviewer", instructions: "Investigate option B", dependencies: [] },
        { id: "report", title: "Write recommendation", memberId: "reviewer", instructions: "Review both results and write the recommendation", dependencies: ["option-a", "option-b"] },
      ],
      finalTaskId: "report",
    },
  },
});

const completion = invoke("worker_team_execute", {
  input: { runId: run.id, expectedRevision: run.revision },
});
// Query the board while completion is pending.
const board = await invoke("worker_team_run_get", { runId: run.id });
const finished = await completion;
```

Omitting `plan` requests one strict JSON plan from the configured model. The
planner cannot call tools. Optional `plannerModel` and each member's optional
`model` use `{ modelId, providerId?, reasoningEffort? }`. Effort values are `low`,
`medium`, `high`, `xhigh`, or `max`, subject to provider support. Otherwise the
existing default model/provider applies. A supplied plan does not call a model.

Member/task IDs contain ASCII letters, digits, `_`, or `-`, up to 120 characters.
Plans have 1–64 tasks and 1–8 members; concurrency is 1–8, with one active task
per member. Every task must contribute through dependencies to `finalTaskId`.
There can be four active runs in one process. All members share the specified
existing workspace and native tool permissions. The limit counts Team tasks,
not additional work a member may delegate through existing native tools.

## Board and control semantics

The Usage tab reads `worker_token_usage_details` with `teamRunId` from the same
SQLite authority as global Profile usage. It shows reported run totals and
task/purpose breakdowns, including planning and attributable background work,
with input, cached/non-cached input, output, and reasoning subsets. Missing
usage and uncertain/failed/retried requests remain visible. Expand request
details for stable logical-request, invocation, task-attempt, Thread and Turn IDs.
History is paginated and survives restart; historical unattributed usage and
shared memory consolidation are not guessed into a Team.

The run ID is allocated before planning so planner usage belongs to the eventual
run. If planning fails before a board is saved, its usage remains inspectable in
global request history under that allocated ID. Descendant Threads recover
origin through persisted parent IDs. Direct Team attempts remain excluded from
automatic memory extraction; attribution does not enable extra background work.

A run contains `schemaVersion`, `id`, numeric `revision`, the immutable `spec`,
`finalTaskId`, `tasks`, `status`, `createdAt`, `updatedAt`, and nullable `error`.
Each task record contains its `task` definition, `status`, and ordered `attempts`.
Attempts contain `threadId`, `turnId`, `status`, `startedAt`, nullable `finishedAt`,
`output`, nullable `message`, and `error`. The final answer is the successful final task's last output.

Run statuses: `planned`, `running`, `paused`, `completed`, `failed`, `cancelled`,
`interrupted`. Task/attempt statuses: `pending`, `running`, `succeeded`, `failed`,
`cancelled`, `interrupted` (attempts themselves never use `pending`).

`expectedRevision` prevents stale edits and execution requests. Refresh the board
after a conflict. Successful tasks and attempted task definitions cannot be
rewritten. Revisions may edit/reassign unattempted tasks or add/remove them while
idle, but must retain a valid complete dependency plan.

`action: "pause"` stops dispatch and drains current tasks. `"cancel"` cooperatively
cancels current tasks and drains cleanup. While active, these return an accepted
process-local signal's current board, possibly still `running`; poll until it
settles. They do not increment the revision until the scheduler persists a change.
For idle runs they persist the status immediately. Neither action takes task IDs.

`action: "retry"` requires explicit nonempty `taskIds` identifying only failed,
cancelled, or interrupted tasks. It requeues them and keeps all attempt history;
it does not start execution. Call execute with the returned revision. Successful
tasks are preserved. All failed/cancelled/interrupted tasks must be requeued
before execution can resume. Retries use new Threads and may repeat external
side effects: inspect uncertain attempts before explicitly requesting retry.

An orphaned running run is marked interrupted when read after restart. Pending
work can resume once interrupted attempts have been explicitly handled. No
background recovery automatically starts work. A native Turn yielding for human
input is currently reported as a failed Team task; inspect and resolve its Thread
before retrying. Automatic adoption of a human-resumed Turn, live peer chat,
workspace merge/isolation, live board events, and automatic replanning are outside
this initial backend interface. Native Thread/tool events remain available.

## Shared message board

Each successful new attempt has a `message`: `{ summary, unresolved, artifacts, sequence }`.
An artifact contains `{ path, sha256, bytes }`; paths are workspace-relative.
The attempt's Thread/Turn and containing task supply author/provenance; sequence
is the run revision that published it. The scheduler saves message and successful
status in the same atomic snapshot before releasing dependencies. `output` is the
summary; detailed results should be files. Original tool inputs, receipts and
conversation evidence remain in the producing Thread.

Active Team attempts receive these model tools (ordinary Threads do not):

| Tool | Input | Behavior |
| --- | --- | --- |
| `team.complete_task` | `{ summary, artifacts: string[], unresolved }` | Validate and finish the Turn; call alone after all work |
| `team.list_messages` | `{ afterSequence?, offset?, limit?, taskId? }` | Completed-message index and summaries; up to 8 entries per page |
| `team.read_message` | `{ entryId, byteOffset?, maxBytes? }` | One bounded message; legacy output uses byte paging |
| `team.read_artifact` | `{ entryId, artifactIndex, byteOffset?, maxBytes? }` | Verify content identity and return selected UTF-8 bytes |

Limits are UTF-8 bytes: summary and unresolved each at most 1024, persisted
message at most 4096 (including reserved sequence space), at most 8 artifacts,
path at most 512, and each file at most 32 MiB. Oversized/malformed submissions
return tool errors for correction; a plain final response fails the Team task.
Successful completion ends the native loop without another provider request.

Downstream `dependencyResults` contain entry/task/member IDs, sequence, a legacy
flag, and optional summaries. The total automatically included summary text is
at most 8192 bytes; remaining summaries are available through read_message.
No artifact bodies, unresolved details, or old full outputs are auto-injected.
Other completed tasks in the same run are discoverable through list_messages.
The board is run-scoped collaboration data, not long-term memory extraction.

Lists return `nextOffset` and `revision`; keep afterSequence fixed while paging,
then use the returned completed revision when checking for newer messages.
Reads default to 8192 bytes, accept maxBytes from 4 to 8192, and return `text`,
`byteOffset`, `nextByteOffset`, and `totalBytes`. Offsets must be valid UTF-8
boundaries. Artifacts also return path and sha256. Missing, changed, binary,
unauthorized, or invalid references are explicit errors; bytes are never silently
presented as the original artifact after modification. Desktop previews use the
same reader, with workspace and paths derived from the saved run.

## Saved run compatibility

Schema 3 adds the optional attempt message. Reading versions 1 and 2 migrates
once and persists a new revision; version 1 IDs also become missing display
names/titles. Legacy successful outputs remain intact with message=null, appear
on the board as legacy entries (sequence 0), and can be read in bounded pages.
Resumed legacy runs use this reference-only handoff for old outputs and require
the new completion contract for new attempts. Unknown versions remain errors.
