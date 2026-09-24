# Tool Registry
<!-- tinybot-module-fingerprint: sha256:c9de505fbf93bd59ad20aa935b07f3d9dcf0e8c5a597424a4344e35277c92d36 -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

`search_file_content` is model-visible by default and targets
`workspace.search_file_content`. It requires only `FsWorkspaceRead`, permits
parallel searches, and uses terminate-process cancellation. Its description
teaches literal/regex matching, scope filters, explicit-file behavior, and the
need to narrow an incomplete search. Explicit tool selections still apply.

The built-in `create_automation` tool is model-visible and routes to the native
Agent bridge. Its schema describes supported schedules, RFC 3339 start times,
workspace and conversation selection, and optional model overrides. It requires
`AutomationWrite` and `SessionMetadataRead`, executes exclusively, and forbids detachment.

Contributors add built-in, web, workspace, MCP, runtime-control, Agent Graph,
and project-group workspace-Thread tools to a single searchable registry.
The built-in MCP contributor exposes credential-redacted list and status
operations plus a typed, revision-guarded upsert. It deliberately does not
expose generic configuration mutation to the model.
Agent Graph entries are deferred tools bound to a canonical definition
workspace, Graph ID, and revision; their provider schema exposes only the
transient Run input. Dynamic contributors must enforce their eligibility scope
so coordinator-only or cross-workspace tools do not appear in ordinary
Threads.

Workspace-thread spawn and send entries have dedicated execution targets handled
by the Agent bridge dispatcher. They are not loop-state runtime controls. Their
schemas, capability grants, parallelism, and cancellation policy remain registry
metadata; the bridge rechecks project membership and parent ownership on execution.

Provider-visible schemas include nested contracts used by native validation.
For `publish_data_view`, disjoint view shapes prevent mixing table sorting with
chart encodings, and column shapes reserve numeric formatting for number columns.
Row IDs accept nonblank natural identifiers; column and source keys retain their
documented identifier pattern.
The `write_stdin` contract distinguishes empty-input completion waits from
interactive writes. It exposes waits up to 300 seconds and explains output
batching, the 5-second floor, and the default 30-second background wait.
The `exec_command` description teaches the complete long-command workflow:
start once, distinguish the initial wait from a process timeout, reuse the
process ID and latest cursor, and prefer longer continuation waits over
repeated short polls.

`apply_patch` exposes `thenRun` only when Action Fusion and Exec are enabled and
ShellExecute is granted. The Turn router also removes it when either
`exec_command` or `write_stdin` is excluded from the selected tools. Patch
execution stays exclusive with detach-forbidden cancellation cleanup.
The top-level patch description advertises fusion under those same conditions;
removing thenRun also restores the original description. Its guidance limits
fusion to a known verification command that needs no intermediate inspection.
The patch description requires workspace-relative paths and a '+' prefix on
every Add File content line, including empty lines. Retry guidance points to
the diagnostic and committed changes; diagnostic line numbers address the
submitted patch rather than the target file.

The Team board contributor adds complete/list/read/artifact-read tools only for active attempts. Its TeamBoard execution target routes to the bridge; completion is exclusive and ends the native turn after validation. Generic RPC cannot invoke this application-owned target.

The Chat coordinator contributor uses TeamCoordinator for recruit/wait/inspect,
result reads and explicit control/resume. These SessionWrite tools execute in
exclusive waves through the bridge and are unavailable in employee scopes or
generic Worker RPC.
