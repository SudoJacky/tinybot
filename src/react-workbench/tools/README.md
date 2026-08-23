# Tools Route
<!-- tinybot-module-fingerprint: sha256:4f65a2647d28ee020e169fa6fe04822c60594b15191b779b53473a2a3dfa8062 -->

`tools` owns the lazy Tools and Plugins route, including catalog, lifecycle,
migration, loading, and visible failure states. Its stylesheet is loaded with
the route.

Tool and plugin mutations go through `ToolsStore`. Native protocol details and
normalization remain in the adapter and app-core modules.
