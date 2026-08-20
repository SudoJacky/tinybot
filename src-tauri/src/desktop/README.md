# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:fddf488312dabfde578f69c98576825c86cecd4c1f34e7d29989752f685ab676 -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`bootstrap` also manages the Sidecar terminal runtime. That PTY process manager
is separate from Agent shell-tool state, and window-close cleanup terminates it
before the native runtime and desktop window are destroyed.

Frontend-facing command handlers live separately in `desktop_commands/`.
Bootstrap registers the Agent Graph definition store alongside the hook
catalog, managed save/test/archive, constrained managed-script editing, and
exact-definition trust commands. Graph storage remains owned by `agent_graphs`;
hook behavior remains owned by `command_hooks` and the Agent runtime.

`logging` owns the `tinybot.native_log.v1` record, severity levels, context
redaction and bounds, the platform log path, and 5 MiB single-backup rotation.
Runtime, renderer, updater, browser, and trace streams share this collector and
the persistent `native-backend.log`; the shared desktop runtime keeps the
latest 200 state-aware records in memory as well. `desktop_performance_snapshot`
combines that bounded event ring with the process-local runtime metrics
snapshot for the renderer's Performance Trace route. A collector failure is
reported directly to stderr so a logging failure cannot recurse or disappear
silently.

`diagnostics` owns the Performance Trace command and the native save-dialog
flow for local diagnostic ZIPs. It revalidates and redacts the bounded renderer
ring, reads only the bounded tail of current and rotated structured native
logs, omits malformed lines, allowlists system metadata, writes a manifest,
and atomically activates the ZIP. The renderer receives only the export result;
it does not own log paths, ZIP layout, or upload behavior.
