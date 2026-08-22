# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:fa14621717f000936a0b06d6a3ceadb9fae08877122710ff22d15c949245e950 -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`files` detects supported images by content when the chat picker returns them,
copies them into content-addressed application storage, and returns their hash
with the managed path. Other selected files retain their original path, and no
file bytes cross the Tauri command boundary.

`bootstrap` also creates the Windows-only `desktop-pet` transparent webview
window through `pet`. The pet window remains independent from the main window,
stays available when the main window is minimized, and converts its own close
request into a hide event. Closing the main window still shuts down the Sidecar
terminal and native runtimes first, then destroys the pet and main windows.

Frontend-facing command handlers live separately in `desktop_commands/`.
Bootstrap registers the Agent Graph definition store and linear Graph Run
runtime alongside the hook catalog, managed save/test/archive, constrained
managed-script editing, and
exact-definition trust commands. Graph definition storage remains owned by
`agent_graphs`, while `graph_runs` owns Run status and delegates Agent nodes to
the standard Thread/Agent path. Hook behavior remains owned by `command_hooks`
and the Agent runtime.

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
