# Tools Route
<!-- tinybot-module-fingerprint: sha256:508f4130a70c7858ddfe19d6eea1ae1709684d5bd08e9fa9bad51470a0c68c3d -->

`tools` owns the lazy Tools and Plugins route, including separate Plugins,
Skills, MCP, and callable Tools views plus catalog, lifecycle, migration,
loading, and visible failure states. Its stylesheet is loaded with the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.
