# Tools Route
<!-- tinybot-module-fingerprint: sha256:3287d56a31792eb6d5e17b2de07aed63451cefb7c58356e33ee1decf079f10e6 -->

`tools` owns the lazy Tools and Plugins route, including catalog, lifecycle,
migration, loading, and visible failure states. Its stylesheet is loaded with
the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.
