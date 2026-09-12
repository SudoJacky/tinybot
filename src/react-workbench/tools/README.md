# Tools Route
<!-- tinybot-module-fingerprint: sha256:7875adbe830d67449d32e060f512d76f54ecf9a1f63872d12653e6ede3505406 -->

MCP form inputs use the panel background token, with existing border, focus, and validation feedback.

`tools` owns the lazy Tools and Plugins route, including separate Plugins,
Skills, MCP, and callable Tools views plus catalog, lifecycle, migration,
loading, and visible failure states. Its stylesheet is loaded with the route.

Tool and plugin mutations go through `ToolsStore`. Global MCP creation goes
through the optional `SettingsStore` transport-specific operations. Configured
MCP rows also load editable settings and apply enabled-state changes through
that boundary. The shared create/edit form switches between STDIO process
fields and Streamable HTTP connection fields while keeping runtime parsing,
secret ownership, and persistence outside React. Saving a definition marks the
catalog for an explicit restart; the restart action preserves the current rows
while discovery is in progress and disappears only after a successful refresh.
Native protocol details and normalization remain in the adapter and app-core
modules.

The route requests its Skill catalog and Skill-detail reads across all existing
workspaces in `WorkspaceRegistry`. It also inherits the active Chat workspace
retained by the desktop shell for MCP, callable Tool, and Agent Graph discovery.
Without an active workspace-backed conversation it omits the directory so
those resources fall back to the configured backend workspace.

The Skills view keeps the catalog lightweight and opens an accessible inline
detail panel on selection. Full `SKILL.md` content is requested only for the
selected imported-workspace or enabled-plugin Skill, with loading, retry, and
close states owned by the route. Same-named Skills in different workspaces
remain distinct rows and details.
