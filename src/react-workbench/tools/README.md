# Tools Route
<!-- tinybot-module-fingerprint: sha256:31f6f2479377298cab0f2a8e09fef96424c8cabd2e3073418ed0023045126770 -->

`tools` owns the lazy Tools and Plugins route, including separate Plugins,
Skills, MCP, and callable Tools views plus catalog, lifecycle, migration,
loading, and visible failure states. Its stylesheet is loaded with the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.

The Skills view keeps the catalog lightweight and opens an accessible inline
detail panel on selection. Full `SKILL.md` content is requested only for the
selected workspace or enabled-plugin Skill, with loading, retry, and close
states owned by the route.
