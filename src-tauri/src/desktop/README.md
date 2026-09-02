# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:bfa2d484a7739e5e3d7a3bfb2a133c2fe577c320db43c0008e6e6c9ca02e8f99 -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`files` is the shared chat-attachment importer for picker and desktop-pet
drops. It rejects non-files, detects supported images by content, copies images
into content-addressed application storage, and returns their hash with the
managed path. Other files retain their original path, and no file bytes cross
the Tauri command boundary.

`bootstrap` also creates the Windows-only `desktop-pet` and
`desktop-pet-chat` transparent webview windows through `pet`. Both remain
independent from the main window and stay available while it is minimized or
hidden in the system tray. Closing the main window hides it without stopping
the browser, terminal, Agent runtime, or desktop pet. The tray restores and
focuses the main window from a left click or the “显示 Tinybot” command; only
“退出 Tinybot” starts the observable cleanup path and terminates the app. A pet
close request hides the pet; a quick-chat close request hides only the panel.
Both auxiliary windows own an explicit empty native menu and keep it
hidden so later application-menu updates cannot attach menu labels or alter
their transparent client area. The pet webview disables Tauri's native
drag-drop handler so frontend HTML5 events continue to receive browser text and
Explorer files. On Windows, `pet_file_drop` owns a narrow WebView2
additional-object bridge: it validates the Tauri invoke key, extracts local
file paths, delegates to the shared attachment importer, and emits a bounded
result back to the pet. `pet` depends only on its initialization and
registration Interface.
Explicit tray exit shuts down the Sidecar browser, terminal, and native Agent
runtimes before requesting process exit.

Frontend-facing command handlers live separately in `desktop_commands/`.
Bootstrap registers the Agent Graph definition store and linear Graph Run
runtime alongside the hook catalog, managed save/test/archive, constrained
managed-script editing, and
exact-definition trust commands. Graph definition storage remains owned by
`agent_graphs`, while `graph_runs` owns Run status and delegates Agent nodes to
the standard Thread/Agent path. Hook behavior remains owned by `command_hooks`
and the Agent runtime.

Bootstrap gives the Thread store and project-group store one shared
`WorkspaceRegistry`. The registry owns `workspaces.json`; the desktop commands
only expose its list, register, display-name rename, and non-destructive forget
operations.

Bootstrap also registers the Thread-scoped workspace file-chunk and raw-byte
commands used by contextual Sidecar Artifact previews. The handlers derive the
workspace from canonical Thread state before routing through the ordinary
guarded workspace reader; bootstrap owns registration only. Desktop MIME
detection recognizes modern `.xlsx` and `.pptx` alongside `.docx`.

`logging` owns the `tinybot.native_log.v1` record, severity levels, context
redaction and bounds, the platform log path, and 5 MiB single-backup rotation.
Runtime, renderer, updater, browser, and trace streams share this collector and
the persistent `native-backend.log`; the shared desktop runtime keeps the
latest 200 state-aware records in memory as well. `desktop_performance_snapshot`
combines that bounded event ring with the process-local runtime metrics
snapshot for the renderer's Performance Trace route. A collector failure is
reported directly to stderr so a logging failure cannot recurse or disappear
silently.

`memory_metrics` owns `tinybot.memory_snapshot.v1`. On Windows it reads the
Rust/Tauri host through process memory counters, asks every live WebView2
environment for its browser/renderer/utility/GPU process list, deduplicates
shared process IDs, and then records private bytes, working set, and peak
working set per process. Failures are returned as scoped collection errors and
mark the snapshot partial; unavailable totals are not replaced with zero. The
memory-only command supports explicit frontend sampling without repeatedly
loading the full metrics and event snapshot. Other platforms return an
explicit unsupported snapshot.

`bootstrap` records process-local duration aggregates for browser runtime
creation, menu installation, auxiliary windows, default files, bundled
plugins, native runtime recovery, and total Tauri setup. These measurements
contain timing only and reuse the existing Performance Trace metrics store.

`diagnostics` owns the Performance Trace command and the native save-dialog
flow for local diagnostic ZIPs. It revalidates and redacts the bounded renderer
ring, reads only the bounded tail of current and rotated structured native
logs, accepts at most 300 memory samples and 4 MiB of sample JSON, omits
malformed lines, allowlists system metadata, writes a manifest, and atomically
activates the ZIP. The renderer receives only the export result; it does not
own log paths, ZIP layout, or upload behavior.
