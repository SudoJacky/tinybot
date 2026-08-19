# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:c25625eeda227b4c18ff959f8d30fe16779049e18be09b545528c33eb60ba409 -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`bootstrap` also manages the Sidecar terminal runtime. That PTY process manager
is separate from Agent shell-tool state, and window-close cleanup terminates it
before the native runtime and desktop window are destroyed.

Frontend-facing command handlers live separately in `desktop_commands/`.
Bootstrap registers the hook catalog and exact-definition trust commands with
the rest of that typed Tauri surface; command execution remains owned by
`command_hooks` and the Agent runtime.

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
