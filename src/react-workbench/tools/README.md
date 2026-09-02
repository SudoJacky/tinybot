# Tools Route
<!-- tinybot-module-fingerprint: sha256:e04cff785dd8201db1ce807e7529b10b583bb23c78ab2620c450e3d1d9da506d -->

`tools` owns the lazy Tools and Plugins route, including separate Plugins,
Skills, MCP, and callable Tools views plus catalog, lifecycle, migration,
loading, and visible failure states. Its stylesheet is loaded with the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.

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
