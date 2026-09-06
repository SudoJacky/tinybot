# Tool Registry
<!-- tinybot-module-fingerprint: sha256:c74093ca439bcb3ee863d9f8832179cba87bf0001f6eaa0794e986820f0c6840 -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

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

Provider-visible schemas include nested contracts used by native validation.
For `publish_data_view`, this includes supported view kinds and the table
`defaultSort` object with required `field` and `direction` properties.
The `write_stdin` contract distinguishes empty-input completion waits from
interactive writes. It exposes waits up to 300 seconds and explains output
batching, the 5-second floor, and the default 30-second background wait.
The `exec_command` description teaches the complete long-command workflow:
start once, distinguish the initial wait from a process timeout, reuse the
process ID and latest cursor, and prefer longer continuation waits over
repeated short polls.
