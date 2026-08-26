# Workspace and Extensions API
<!-- tinybot-doc-watch:
src-tauri/src/desktop_commands/plugins.rs
src-tauri/src/desktop_commands/agent_graphs.rs
src-tauri/src/desktop_commands/graph_runs.rs
src-tauri/src/desktop_commands/skills.rs
src-tauri/src/desktop_commands/workspace.rs
src-tauri/src/agent_graphs.rs
src-tauri/src/graph_runs.rs
src/app-core/native/desktopNativeAgentGraphs.ts
src/app-core/native/desktopNativeAgentGraphRuntime.ts
src-tauri/src/plugins/manifest.rs
src-tauri/src/plugins/manifest_tests.rs
src-tauri/src/skills/definition.rs
src-tauri/src/workspace/types.rs
src-tauri/src/rpc/tests/workspace_and_shell.rs
-->
<!-- tinybot-doc-fingerprint: sha256:d6a8ce95d2f1f3ebcf27417e360353ed482e0c41192c4e7e7af35b69d1ee48b2 -->

This document covers workspace operations and the extension catalogs available
to Agents. It is part of the [Rust backend API reference](rust-backend-api.md),
which defines the shared invocation conventions and source-backed freshness
policy for this reference set.

## Skills Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_skills_list` | none | `{ skills: [...] }` or WebUI list shape |
| `worker_skills_detail` | `{ input: { name } }` | skill detail |
| `worker_skills_create` | `{ input: { body } }` | created skill |
| `worker_skills_update` | `{ input: { name, body } }` | updated skill |
| `worker_skills_delete` | `{ input: { name } }` | delete result |
| `worker_skills_validate` | `{ input: { name } }` | validation result |

These commands belong to the legacy skills API. Native agent turns do not use that managed `<backend-workspace>/skills` directory. They discover enabled global Agent Plugin skills plus project-local `.agents/skills/*/SKILL.md` files from the effective working-directory hierarchy. Project-local skill names are unqualified; plugin skill names remain qualified as `<plugin-name>:<skill-name>`.

Native turns also merge project-local MCP definitions from `mcp.json`, `.mcp.json`, and `.github/mcp.json`. The files may expose a `mcpServers` or `servers` object. Discovery walks from the nearest Git root to the effective working directory, and deeper same-named definitions win without mutating the saved global configuration. `.codex` directories are not scanned.

## Agent Plugin Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_plugins_list` | none | `{ plugins: PluginSummary[] }` |
| `worker_plugin_install` | `{ input: { path } }` | installed `PluginSummary` |
| `worker_plugin_prepare_migration` | `{ input: { path } }` | isolated `PluginMigrationJob` |
| `worker_plugin_install_migration` | `{ input: { jobId } }` | `PluginMigrationInstallResult` |
| `worker_plugin_set_enabled` | `{ input: { name, enabled } }` | updated `PluginSummary` |
| `worker_plugin_uninstall` | `{ input: { name } }` | `null` |

Plugin installs use the Agent Plugins 1.0.0 layout and are global under `~/.tinybot/plugins`. New plugins are enabled by default. `PluginSummary.builtIn` identifies packages bundled with Tinybot. The built-in `create-agent-plugin` is installed during desktop startup, can be disabled, and cannot be uninstalled. Enabling, disabling, replacing, or uninstalling a plugin reconciles the shared MCP runtime. Every replacement receives a new install revision, so reinstalling changed plugin code restarts an existing MCP client even when `mcp.json` is unchanged. Skill names exposed to turn-level selection are qualified as `<plugin-name>:<skill-name>`; plugin MCP server IDs are qualified as `plugin:<plugin-name>:<server-name>`.

Migration preparation accepts a recognized standalone Skill, MCP configuration, or client-plugin directory but does not install it. It rejects already valid Agent Plugins and unrecognized directories, copies the source without following links or reparse points into `~/.tinybot/plugins/migrations/<job-id>/source`, and creates an empty sibling `output` directory for an Agent-assisted conversion turn.

## Agent Graph Definition Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_agent_graphs_list` | `{ input: { workspacePath } }` | `StoredAgentGraph[]` |
| `worker_agent_graph_save` | `{ input: { workspacePath, definition, expectedRevision? } }` | `StoredAgentGraph` |
| `worker_agent_graph_delete` | `{ input: { workspacePath, graphId, expectedRevision } }` | `null` |

Definitions live at `<workspace>/.tinybot/graphs/<graph-id>.json`. Save validates
the versioned definition and atomically replaces one file. The returned
`revision` is the SHA-256 hash of the exact persisted bytes; updates and deletes
must provide it so external edits fail visibly instead of being overwritten.
The first save omits `expectedRevision`, and an existing file cannot be replaced
without one. Listing rejects invalid Graph files rather than hiding them. An
Input node has no configuration: the initial prompt is supplied for each Run
instead of being part of the reusable definition. Loading and saving an older
definition discards its legacy Input prompt. An Agent node stores its execution
`workspacePath`, additional `instructions`, and an optional `model`
tuple containing `modelId`, optional `providerId`, and optional
`reasoningEffort`. Missing required node configuration makes the definition
invalid; test-era files are not migrated or defaulted. Router nodes retain the
schema kind `condition` and store an optional routing `task`, two or more
required `{ id, label, description }` routes, and the same optional model
tuple. Router edges store `sourceRouteId`; every route must own exactly one
outgoing edge.

## Agent Graph Run Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_agent_graph_runs_list` | `{ input: { graphId, definitionWorkspacePath } }` | `AgentGraphRun[]` |
| `worker_agent_graph_run` | `{ input: { graphId, graphRevision, definitionWorkspacePath, input } }` | `AgentGraphRun` |

Runs live at `~/.tinybot/graph-runs/<graph-id>/<run-id>.json` and are atomically
updated as nodes transition. Start requires a non-empty runtime `input`,
reloads the requested saved revision, and copies that runtime value into the
Run so the Input node can be inspected later. It then
canonicalizes every Agent workspace and validates an acyclic Input-to-Output
graph. Router branches may reconverge, while non-Router branching, cycles,
disconnected nodes, incomplete route connections, and missing workspaces fail
preflight. Each visited Agent node creates a fresh standard
parentless Thread with `source: "agent_graph"`; final output becomes the next
Agent input and the Output value. Node instructions enter the existing
turn-scoped agent-role instruction source, while an optional node model tuple
sets the Turn's model, provider, and reasoning effort. A Router performs one
non-streaming provider request with a dedicated system prompt and no Agent
instructions, tools, workspace context, or Thread. It maps an exact generated
`ROUTE_A`-style response back to the route's stable ID; any other response
fails that node without guessing or retrying. Agent terminal failures produce a failed Run
rather than a successful empty result. Parent Turn cancellation propagates to
the active Graph node and records a cancelled Run; crash recovery remains out
of scope.

A workspace-backed Chat Turn may expose each saved Graph from that exact
canonical working directory as a deferred tool. The model supplies only the
runtime `input`; the execution target binds the definition workspace, Graph ID,
and revision so arguments cannot redirect the call. A completed Run's final
output becomes the model-visible tool result. Graph-created Agent node Turns do
not receive Graph tools, preventing nested Graph execution. Unlike the strict
management listing, Chat tool discovery skips invalid Graph files, logs and
returns path-specific diagnostics, and continues with the valid definitions.

The Graph renderer selects a durable Run before inspecting a node. Input and
Output use the Run's boundary values. Agent nodes use the node invocation's
`threadId` with the normal Thread timeline APIs and the shared read-only Chat
timeline renderer; they remain excluded from Chat session discovery. Router
node runs expose the selected route/edge, raw response, and provider usage.

## Workspace Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_workspace_files` | none | `{ files: WorkspaceFileEntry[] }` |
| `worker_workspace_file` | `{ input: { path } }` | `WorkspaceReadFileResult` |
| `worker_workspace_bootstrap_files` | `{ input: { files } }` | `WorkspaceBootstrapFiles` |
| `worker_workspace_put_file` | `{ input: { path, body } }` | `WorkspaceWriteResult` |
| `worker_workspace_directory` | `{ input: { path, cursor?, nameQuery? } }` | Worker response containing `WorkspaceDirectoryPage` |
| `worker_workspace_file_chunk` | `{ input: { path, cursor? } }` | Worker response containing `WorkspaceFileChunk` |
| `worker_thread_workspace_file_chunk` | `{ input: { threadId, path, cursor? } }` | Worker response containing `WorkspaceFileChunk` |

Lower-level workspace RPC also supports:

- `workspace.resolve_path`
- `workspace.read_file`
- `workspace.read_file_chunk`
- `workspace.read_bootstrap_files`
- `workspace.write_file`
- `workspace.apply_patch`
- `workspace.create_dir`
- `workspace.list_dir`
- `workspace.list_dir_page`
- `workspace.delete_file`
- `workspace.list_files`

`WorkspaceReadFileResult`:

```json
{
  "path": "README.md",
  "contents": "...",
  "content": "...",
  "updated_at": "2026-07-06T00:00:00Z",
  "content_type": "text/plain",
  "line_start": 1,
  "line_end": 100,
  "line_total": 250,
  "truncated": false
}
```

Workspace browsing uses paginated read commands instead of loading an unbounded
tree or file. `worker_workspace_directory` returns a Worker response whose
`result` has this shape:

```json
{
  "path": "src",
  "workspace_key": "D:/code/tinybot",
  "listing_revision": "...",
  "entries": [
    {
      "path": "src/app-core",
      "kind": "directory",
      "size_bytes": null,
      "updated_at": "2026-07-14T00:00:00Z"
    }
  ],
  "next_cursor": null
}
```

Directories sort before files, entries are then ordered by normalized path, and `nameQuery` filters
entry names before pagination. A continuation cursor is bound to `listing_revision`; using it after
the directory changes fails visibly with query code `listing_changed`.

`worker_workspace_file_chunk` returns a Worker response whose `result` has this shape:

```json
{
  "path": "src/main.ts",
  "content_type": "text",
  "revision": "...",
  "size_bytes": 1024,
  "updated_at": "2026-07-14T00:00:00Z",
  "content": "...",
  "line_start": 1,
  "line_end": 40,
  "next_cursor": null
}
```

Binary files return `content_type: "binary"` without invented text content or line numbers. File
continuation cursors are bound to `revision`; using one after the file changes fails visibly with
query code `source_changed`. Other workspace query failures retain their protocol error, path, and
retryable metadata rather than returning an empty successful page.

`worker_thread_workspace_file_chunk` is the Sidecar Artifact preview boundary.
It resolves the Thread from the canonical rollout projection and selects that
Thread's recorded `workingDirectory`; an unbound Thread uses the configured
default workspace. Absolute paths are accepted only when their canonical target
is below that root, then converted to workspace-relative paths before the same
chunk reader handles them. The renderer cannot supply a workspace root, and
relative traversal, symlink escape, binary content, stale cursors, and I/O
errors retain the normal structured workspace failure behavior.

`workspace.apply_patch` accepts:

```json
{
  "patch": "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch",
  "sessionId": "websocket:chat-1",
  "turnId": "turn-1"
}
```

The patch grammar supports `*** Add File: path`, `*** Update File: path`, and
`*** Delete File: path` operations between `*** Begin Patch` and `*** End Patch`. Update operations
also support an optional `*** Move to: path`; hunks begin with `@@` or `@@ context`, may be pure
additions, and may end with `*** End of File`. The first hunk may omit `@@` and begin directly with a
space, `+`, `-`, or blank context line. Header markers accept surrounding whitespace only while the
parser is expecting a top-level header. Inside an update body, control markers must begin in column
zero, so indented marker text remains file content. Blank lines after `*** End of File` are ignored.

Hunk lookup follows the Codex apply-patch matching order: exact, ignore trailing whitespace, ignore
surrounding whitespace, then normalize common Unicode punctuation. Tinybot additionally requires
the selected match to be unique at the winning strictness, so ambiguous patches fail instead of
silently choosing the first occurrence.

The RPC requires both `fs.workspace.read` and `fs.workspace.write`. All targets and source contents
are prepared before writing. Paths must stay inside the workspace; symlink escapes, path aliases,
and non-regular update/delete targets are rejected; add and move destinations cannot overwrite; and
a file may appear only once per patch. Limits are 4 MiB, 256 file operations, 256 hunks per updated
file, and 64 MiB per target file. Each changed file is written atomically. Updated and moved files
preserve their source permissions and existing LF or CRLF line ending.

For model-dispatched workspace tools, `workspace` means the current turn's resolved
`workingDirectory`/`cwd`. The thread store continues to use the backend persistence workspace; its
root must not be reused for file mutations when the conversation is attached to a different working
directory. Direct worker RPC callers that do not carry turn context retain their configured
workspace root.

A multi-file patch is committed in operation order and is not globally transactional. If a later
filesystem operation fails, the protocol error includes `details.committed` with the exact known
`changed_files`, `files_changed`, `hunks_applied`, and `exact` status for changes already committed;
the agent bridge retains these structured details in its surfaced error instead of dropping them.

Result shape:

```json
{
  "changed_files": [
    {
      "path": "README.md",
      "operation": "update",
      "move_path": "docs/README.md",
      "hunks": [{ "index": 1, "removed_lines": 1, "added_lines": 1 }],
      "delta": [{
        "old_start": 1,
        "new_start": 1,
        "old_lines": ["old"],
        "new_lines": ["new"]
      }],
      "delta_truncated": false
    }
  ],
  "files_changed": 1,
  "hunks_applied": 1
}
```

`delta` contains the exact matched source lines and replacement lines used by the desktop change
preview. It is capped at 2 MiB per changed file; larger previews return an empty `delta` with
`delta_truncated: true` while the patch itself still succeeds and the summary remains available.

After typed parameter, JSON-schema, capability, and availability validation,
`workspace.apply_patch`, `workspace.write_file`, `workspace.delete_file`, `shell.execute`,
`shell.start`, browser interaction, and MCP tool calls dispatch directly.

`permission_profile.evaluate_tool` still reports normalized `effects` as descriptive metadata:

```json
{
  "filesystem": {
    "readRoots": ["filesystem://unrestricted"],
    "writeRoots": ["filesystem://unrestricted"]
  },
  "network": {
    "mode": "unrestricted",
    "destinations": ["network://unrestricted"]
  },
  "process": { "execute": true, "interactive": false },
  "environment": {
    "inherit": true,
    "secretScopes": ["environment://ambient-process"]
  },
  "mcp": [],
  "mutatesSession": false,
  "mutatesBackground": false
}
```

Workspace tools use exact workspace-relative write roots where possible; strict multi-file patches
use the whole current workspace. MCP effects name both destination server and tool. Subagent tools
mark session/background mutation. Shell effects explicitly report unrestricted current-user
filesystem, network, process, and inherited-environment access. These effects are diagnostic
metadata, not an enforcement boundary.
