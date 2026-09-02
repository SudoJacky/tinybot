# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:6169084176009b5e15308c8d45ae2e2ab380c129481307ce8d5e4d0dc83b1dc0 -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, hooks, memory, runtime,
skills, plugins, project groups, the workspace registry, Agent Graph
definitions, threads, retry, WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

Workspace-registry commands expose the single renderer-facing catalog write
path: list, register, rename, and forget. Rust canonicalizes registered folders,
persists portable paths in `workspaces.json`, and performs the legacy
Thread/project-group import only until the registry's migration marker is
written. Forget is rejected while a project group references the path and never
deletes filesystem content.

The Rust-owned `GET /api/tools` route combines the callable tool catalog with
separate MCP server and Skill summaries. With an explicit `workingDirectory`,
the catalog also contains deferred Agent Graph tools from that exact workspace;
workspace-less requests receive no Graph tools. Workspace Skills come from
`.agents/skills` and `.codex/skills`; full Skill documents remain outside the list response and
are loaded on demand through `GET /api/tools/skills/{id}` for workspace and
enabled-plugin entries only. Both Tools routes accept an optional
`workingDirectory` query so Chat can catalog the active Thread workspace while
non-Graph entries for callers that omit it continue to use the configured
backend workspace. The Tools & Plugins inventory adds
`skillScope=allWorkspaces`; this reads `WorkspaceRegistry` once and combines
Skills from every existing imported workspace without changing the
`workingDirectory` scope used for MCP, callable Tools, or Agent Graphs. The
detail route accepts the same scope for aggregate workspace Skill IDs.
Invalid Agent Graph files are omitted only from this tool-discovery response and
reported in `agentGraphDiagnostics`; the dedicated Graph management commands
continue to reject invalid saved definitions.

Workspace file queries normally use the configured default workspace. The
Thread file-preview commands are the scoped exception: they accept a Thread ID,
derive the recorded working directory from the canonical Thread projection,
and then delegate to the same guarded workspace reader. Text uses the ordinary
chunk response. Modern Office files use a raw IPC response capped at 25 MiB and
may require the metadata revision so a changed source fails explicitly. Neither
command accepts a renderer-supplied workspace root.

Agent Graph commands pass workspace-scoped list, save, and delete requests to
`agent_graphs`. Schema checks, path containment, atomic writes, and optimistic
revision conflicts stay out of the Tauri boundary.
Graph Run commands pass history and start requests to `graph_runs`; the command
layer requires the transient Run input and supplies the shared Agent services,
application data root, and runtime configuration.

Hook commands resolve an existing workspace directory, return the additive
global/workspace catalog, and mutate trust only after the backend confirms the
requested exact-definition hash is still configured. They never execute a
hook implicitly from the Tauri command boundary. Managed-hook commands delegate
save, isolated sample testing, and recoverable archive behavior to
`command_hooks`. Managed-script read and save commands also delegate path
derivation, containment, size, and revision checks there; the command layer
only resolves and validates the workspace.

Chat creation, cancellation, form resolution, and operation retry use typed
Thread commands. Retry validates the failed source Turn and canonical Item
before starting a new correlated Agent turn.
