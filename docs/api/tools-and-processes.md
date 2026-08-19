# Tools and Processes API
<!-- tinybot-doc-watch:
src-tauri/src/native_browser/commands.rs
src-tauri/src/native_browser/model.rs
src-tauri/src/rpc/background_dispatch.rs
src-tauri/src/rpc/subagent_dispatch.rs
src-tauri/src/rpc/tool_dispatch.rs
src-tauri/src/tools/shell/mod.rs
src-tauri/src/tools/shell/process_manager.rs
src-tauri/src/rpc/tests/threads_and_tools.rs
-->
<!-- tinybot-doc-fingerprint: sha256:742abc2ac50cbf1bbc6cdb9fbf0c8bd949dcb29ddecbf56faa5d58fc3aedf52e -->

This document covers native tool processes, background execution, and browser
sessions. It is part of the [Rust backend API reference](rust-backend-api.md),
which defines the shared invocation conventions and source-backed freshness
policy for this reference set.

## Owned Shell Processes

The Rust worker owns live shell processes behind `WorkerShellRpc`. `shell.execute` remains the
one-shot compatibility method, but it now starts and waits through the same process manager used by
interactive sessions. Its returned stdout/stderr is bounded by the manager's retained transcript.
The manager is held by `NativeAgentRuntimeServices`, so separate per-tool Worker RPC router instances
share the same live process store.

The worker tool registry also receives the current config snapshot. An explicit
`tools.exec.enable: false` marks `shell.execute` and `exec_command` unavailable and rejects direct
starts. `tools.exec.timeout` supplies the default one-shot timeout. Process-management tools remain
available so a previously started process can be polled or terminated safely.

Model-visible deferred tools map to the richer RPC surface:

| Tool | Worker RPC target | Cancellation policy |
| --- | --- | --- |
| `exec_command` | `shell.start` | `terminate_process` |
| `write_stdin` | `shell.write_stdin` | `detach_forbidden` |

The tool executor overwrites tool-supplied identity fields with the active `sessionId`, `turnId`,
and `toolCallId` when these tools dispatch. `shell.start` uses `turnId` as the retained process
`ownerId`. An owned process cannot be polled, written, resized, interrupted, or terminated without
that matching `ownerId`.

### Shell RPC methods

| Method | Purpose |
| --- | --- |
| `shell.start` | Start a pipe or PTY process and wait for a bounded initial yield. |
| `shell.poll` | Return output after a sequence cursor, waiting up to `yieldTimeMs`. |
| `shell.write_stdin` | Write `input` (or alias `chars`) and return newly available output. |
| `shell.resize` | Resize an active PTY in rows and columns. |
| `shell.interrupt` | Send SIGINT on Unix or Ctrl-C to a Windows PTY. |
| `shell.terminate` | Terminate one owned process tree and verify its exit. |
| `shell.terminate_owner` | Terminate all live processes owned by one owner. |
| `shell.list` | List retained process snapshots, optionally filtered by `ownerId`. |
| `shell.shutdown` | Terminate live processes, join terminal lifecycle threads, and release records. |

`shell.start` accepts:

```json
{
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "yieldTimeMs": 1000,
  "rows": 24,
  "cols": 80,
  "turnId": "turn-1",
  "toolCallId": "call-1"
}
```

`turnId` and `toolCallId` are required for retained processes. The resulting process snapshot exposes
that Turn identity as `ownerId`. The one-shot `shell.execute` adapter uses an internal transient
owner and releases its record before returning.

There is no shell sandbox or shell-specific network isolation. Commands inherit the Tinybot
process's current-user permissions and environment. `workingDir` accepts an existing absolute
directory, including one outside the workspace, or a path relative to the workspace root.

Windows pipe processes receive a dedicated kill-on-close Job Object immediately
after creation. Failure to create or assign that job fails the start and terminates the direct child.
`shell.terminate`, turn cancellation, and Native Runtime shutdown terminate the job and verify the root
record reaches terminal state, preventing descendants from retaining inherited pipe handles or
surviving the owner.

Process snapshots use camel-case fields and include:

```json
{
  "processId": "process-1",
  "systemProcessId": 1234,
  "ownerId": "turn-1",
  "toolCallId": "call-1",
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "status": "running",
  "running": true,
  "exitCode": null,
  "stdout": "",
  "stderr": "",
  "output": "",
  "chunks": [],
  "cursor": 0,
  "truncated": false,
  "droppedBytes": 0,
  "startedAtMs": 0,
  "lastActivityMs": 0,
  "failure": null
}
```

Pipe processes preserve stdout/stderr chunk identity. PTY output uses the `terminal` stream and is
projected into stdout for compatibility. The retained transcript keeps a 256 KiB head and 768 KiB
tail; `truncated` and `droppedBytes` make any omission explicit. Unknown process IDs and writes after
exit are errors, not empty successful polls. On Windows, the manager normalizes terminal input,
answers ConPTY cursor-position probes internally, and removes verbatim path prefixes only at the PTY
spawn boundary. Windows pipe processes are assigned to a kill-on-close Job Object so cancellation
and shutdown terminate descendant processes as well as the root process.

## Background, Task, Subagent, and Host Commands

| Group | Commands |
| --- | --- |
| Background trace | `worker_background_trace_list`, `worker_background_trace_get_delegate_trace`, `worker_background_trace_get_artifact`, `worker_background_trace_append` |
| Background subagent input | `worker_background_subagent_enqueue_input` |
| Subagent manager | `worker_subagent_spawn`, `worker_subagent_list`, `worker_subagent_query`, `worker_subagent_send_input`, `worker_subagent_wait`, `worker_subagent_cancel`, `worker_subagent_close`, `worker_subagent_resume` |
| Task plans | `worker_task_plan_list`, `worker_task_plan_get`, `worker_task_plan_save`, `worker_task_plan_delete` |
| Chat retry compatibility | `worker_dispatch_tinyos_host_command` |
| WebUI proxy | `worker_webui_route` |

### Subagent lifecycle

The desktop commands and Agent tools share the same manager and canonical thread store. The core
lifecycle tools `subagent.spawn`, `subagent.send_input`, `subagent.wait`, `subagent.close`, and
`subagent.resume` are model-visible by default. `subagent.list`, `subagent.query`, and
`subagent.cancel` remain Worker RPC and desktop-control operations.

The default limits are eight active children per session, 32 active children process-wide, and a
maximum delegation depth of four. Nested spawns must name their direct `parentSubagentId` and exact
`delegationDepth`; the persisted child thread is attached to that direct parent's thread. Capacity
and depth failures are explicit control errors and do not create partial durable edges.

`historyMode` controls the public conversation copied into a child thread:

- `isolated` copies no parent messages;
- `parent_turn` copies user and completed assistant messages from the latest user turn;
- `full_history` copies all user and completed assistant messages.

Reasoning, tool calls and outputs, and private trace items are never inherited. Copied
messages contain source-thread and source-item provenance and use deterministic child item IDs.

After a process restart, canonically persisted active children are restored as `interrupted`.
`subagent.resume` selectively returns one interrupted child to `running`; explicitly closed or
otherwise terminal children cannot be reopened. `close` is a lifecycle retention decision, while
`cancel` records task cancellation; completed, failed, cancelled, and interrupted children remain
queryable until explicitly closed. `subagent.wait` blocks until a selected child reaches a waiting
or terminal boundary, the timeout expires, or the parent request is cancelled. The timeout defaults
to 30 seconds and is capped at 30 seconds. Waiting does not write polling snapshots into thread
history.

Retry command input example:

```ts
await invoke("worker_dispatch_tinyos_host_command", {
  input: {
    clientId: "client-1",
    frame: {
      type: "command",
      command_kind: "operation.retry",
      turn_id: "turn-retry-1",
      source_turn_id: "turn-failed-1",
      item_id: "turn-failed-1:error"
    },
    attachedChatId: "thread-1",
  }
});
```

This transitional dispatcher accepts only `operation.retry`. Chat turns,
interruption, and forms use the typed Thread commands. Retired desktop file,
terminal, browser-control, pause/resume, and request-change frames fail closed.

## Native Browser session runtime

The backend-owned WebView2 runtime is part of the default Windows desktop build. A deliberately
minimal build compiled with `--no-default-features` returns unavailable decisions with reason code
`feature_disabled`. The remote child webviews are not members of the Tauri capability set,
`withGlobalTauri` is disabled, and page content receives no TinyBot IPC or privileged host object.
Non-Windows builds return unavailable decisions with reason code `platform_unsupported` rather than
synthetic browser state.

The public commands are:

| Command | Input | Result |
| --- | --- | --- |
| `browser_capabilities` | none | `tinybot.browser_runtime_capabilities.v1` |
| `browser_metrics` | none | bounded counters and last-duration metrics |
| `browser_create_session` | owner session, optional profile/persistence/initial URL | authoritative `browser_session_v1` snapshot; idempotent by owner session |
| `browser_snapshot` | browser session identity | current authoritative snapshot |
| `browser_close_session` | browser session identity | cleanup completion or an incomplete-cleanup error |
| `browser_create_tab` | browser session and optional URL | updated snapshot |
| `browser_activate_tab`, `browser_close_tab`, `browser_restart_tab` | browser session and tab | updated snapshot |
| `browser_navigate` | browser session, tab, URL | updated snapshot after dispatch |
| `browser_back`, `browser_forward`, `browser_reload`, `browser_stop` | browser session and tab | completion or exact platform error |
| `browser_update_surface` | surface identity, layout revision, CSS-pixel rectangle, scale and visibility gates | updated snapshot |
| `browser_observe` | browser session, tab, capture/semantic flags | snapshot plus optional real capture and semantic observation |
| `browser_interact` | session, tab, command, control epoch, observation/capture identities and typed action | terminal command result |
| `browser_resolve_policy_request` | browser session, pending request identity, allow/deny decision | updated snapshot after the confirmed popup or external-protocol operation finishes |
| `browser_delete_profile` | profile identity | cleanup completion or an exact deletion error; active profiles are rejected |

Session ownership, control epochs, observations, protected handoff, profile cleanup, privacy limits,
and native integration verification are documented in `src-tauri/src/native_browser/README.md`.
