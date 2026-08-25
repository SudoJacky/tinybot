# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:f88eff7d47b865458660fe2e15d2f156d52d3a31193ea47b2280ebb6b09a95de -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, hooks, memory, runtime,
skills, plugins, project groups, Agent Graph definitions, threads, transport,
WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

The Rust-owned `GET /api/tools` route combines the callable tool catalog with
separate MCP server and Skill summaries. Workspace Skills come from
`.agents/skills`; full Skill documents remain outside the list response.

Workspace file queries normally use the configured default workspace. The
Thread file-preview command is the scoped exception: it accepts a Thread ID,
derives the recorded working directory from the canonical Thread projection,
and then delegates to the same guarded workspace reader. It never accepts a
renderer-supplied workspace root.

Agent Graph commands pass workspace-scoped list, save, and delete requests to
`agent_graphs`. Schema checks, path containment, atomic writes, and optimistic
revision conflicts stay out of the Tauri boundary.
Graph Run commands pass history and start requests to `graph_runs`; the command
layer only supplies the shared Agent services, application data root, and
runtime configuration.

Hook commands resolve an existing workspace directory, return the additive
global/workspace catalog, and mutate trust only after the backend confirms the
requested exact-definition hash is still configured. They never execute a
hook implicitly from the Tauri command boundary. Managed-hook commands delegate
save, isolated sample testing, and recoverable archive behavior to
`command_hooks`. Managed-script read and save commands also delegate path
derivation, containment, size, and revision checks there; the command layer
only resolves and validates the workspace.

Chat creation, cancellation, and form resolution use the typed Thread commands.
The transitional `worker_dispatch_tinyos_host_command` boundary accepts only
`operation.retry`; the retired desktop file, terminal, browser-control, and
pause/resume commands are not part of this boundary.
