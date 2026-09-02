# Tools Route
<!-- tinybot-module-fingerprint: sha256:5aa05f4f78723ff733bb396a8b53bed58ac35fc83a8eb10459d5bc50f8275e7f -->

`tools` owns the lazy Tools and Plugins route, including separate Plugins,
Skills, MCP, and callable Tools views plus catalog, lifecycle, migration,
loading, and visible failure states. Its stylesheet is loaded with the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.

The route inherits the active Chat workspace retained by the desktop shell and
uses it for the callable catalog and Skill-detail reads. Without an active
workspace-backed conversation it omits the directory so Rust falls back to the
configured backend workspace.

The Skills view keeps the catalog lightweight and opens an accessible inline
detail panel on selection. Full `SKILL.md` content is requested only for the
selected workspace or enabled-plugin Skill, with loading, retry, and close
states owned by the route.
