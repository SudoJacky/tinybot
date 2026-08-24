# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:4f8b2d07cb8e06a3bc987e986e1e751986258d431006b1d458216fca4bb80d7c -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`files` is the shared chat-attachment importer for picker and desktop-pet
drops. It rejects non-files, detects supported images by content, copies images
into content-addressed application storage, and returns their hash with the
managed path. Other files retain their original path, and no file bytes cross
the Tauri command boundary.

`bootstrap` also creates the Windows-only `desktop-pet` and
`desktop-pet-chat` transparent webview windows through `pet`. Both remain
independent from the main window and stay available while it is minimized. A
pet close request hides the pet; a quick-chat close request hides only the
panel. Both auxiliary windows own an explicit empty native menu and keep it
hidden so later application-menu updates cannot attach menu labels or alter
their transparent client area. The pet webview disables Tauri's native
drag-drop handler so frontend HTML5 events continue to receive browser text and
Explorer files. On Windows, `pet_file_drop` owns a narrow WebView2
additional-object bridge: it validates the Tauri invoke key, extracts local
file paths, delegates to the shared attachment importer, and emits a bounded
result back to the pet. `pet` depends only on its initialization and
registration Interface.
Closing the main window still shuts down the Sidecar terminal and native
runtimes first, then destroys both auxiliary windows and the main window.

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

`bootstrap` records process-local duration aggregates for browser runtime
creation, menu installation, auxiliary windows, default files, bundled
plugins, native runtime recovery, and total Tauri setup. These measurements
contain timing only and reuse the existing Performance Trace metrics store.

`diagnostics` owns the Performance Trace command and the native save-dialog
flow for local diagnostic ZIPs. It revalidates and redacts the bounded renderer
ring, reads only the bounded tail of current and rotated structured native
logs, omits malformed lines, allowlists system metadata, writes a manifest,
and atomically activates the ZIP. The renderer receives only the export result;
it does not own log paths, ZIP layout, or upload behavior.
