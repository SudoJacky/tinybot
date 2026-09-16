# Team API
<!-- tinybot-doc-watch:
src-tauri/src/desktop_commands/teams.rs
src-tauri/src/teams/model.rs
src-tauri/src/teams/mod.rs
src-tauri/src/teams/runtime.rs
-->
<!-- tinybot-doc-fingerprint: sha256:e886404fb67f5870f006ddfef853c12a7b283ab969ea61cb5e5b5c77f1fa9cb4 -->

Team commands are available to the main desktop window. They return a `TeamRun`
object or reject with an error string. This backend surface is ready for a future
Team UI; no renderer workflow is added with this module.

| Command | Arguments | Result |
| --- | --- | --- |
| `worker_team_prepare` | `{ input: { spec, plan?, plannerModel? } }` | New planned run |
| `worker_team_runs_list` | None | All runs, newest first |
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
        { id: "researcher", instructions: "Collect source-backed evidence" },
        { id: "reviewer", instructions: "Check claims and synthesize tradeoffs" },
      ],
    },
    plan: {
      tasks: [
        { id: "option-a", memberId: "researcher", instructions: "Investigate option A", dependencies: [] },
        { id: "option-b", memberId: "reviewer", instructions: "Investigate option B", dependencies: [] },
        { id: "report", memberId: "reviewer", instructions: "Review both results and write the recommendation", dependencies: ["option-a", "option-b"] },
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

A run contains `schemaVersion`, `id`, numeric `revision`, the immutable `spec`,
`finalTaskId`, `tasks`, `status`, `createdAt`, `updatedAt`, and nullable `error`.
Each task record contains its `task` definition, `status`, and ordered `attempts`.
Attempts contain `threadId`, `turnId`, `status`, `startedAt`, nullable `finishedAt`,
`output`, and `error`. The final answer is the successful final task's last output.

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
before retrying. Automatic adoption of a human-resumed Turn, team messaging,
workspace merge/isolation, live board events, and automatic replanning are outside
this initial backend interface. Native Thread/tool events remain available.
