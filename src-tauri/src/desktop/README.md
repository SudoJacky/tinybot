# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:a96df8be401a2c9954ced0332596860f76bc472dcd6a5275e022c77cb5923f8f -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

`state.rs` initializes storage through `NativeRuntimeState::initialize`, with
explicit workspace and application-data paths. Migration failure returns an
error before a usable state is created. Workspace rebinding uses the same storage
initializer; unchanged startup does not rerun migration. Startup failures remain
visible in lifecycle status and logs.
Desktop state owns MCP, Shell, browser, subagent and Thread-store resources.
`native_agent_services` creates an application context sharing those instances.
`NativeAgentRuntimeDependencies` contains only core execution dependencies;
Provider, task ownership, cancellation and metrics are selected here.

`files` is the shared chat-attachment importer for picker and desktop-pet
drops. It rejects non-files, detects supported images by content, copies images
into content-addressed application storage, and returns their hash with the
managed path. Picker and pet-drop documents retain their original path.
`import_chat_file` accepts raw bytes plus a base64 UTF-8 filename header for
composer drops and clipboard files without native paths. Imports are bounded
to 32 MiB and stored on a blocking worker; document bytes use managed
content-addressed storage too. Import success and failure are logged.

`bootstrap` creates the Windows-only `desktop-pet` transparent webview through
`pet`. The main renderer invokes `desktop_ensure_pet_quick_chat_window` only
when a quick-chat request arrives; the async native command creates the hidden
`desktop-pet-chat` window. The host retains the latest request until renderer
readiness, then positions, presents and focuses it. Creation failures and a
15-second readiness timeout are observable. Native window creation and host
request-to-presentation durations are recorded. Both windows remain
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
Memory snapshots enumerate native windows independently of their child WebViews,
so attaching a Sidecar does not remove `main` from the report. Each window records
visibility, focus, physical client dimensions and its child WebView labels.
Process labels still describe shared environments, not exclusive renderer ownership.
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

Each memory sample includes window visibility/focus and collection duration.
Window labels on process entries identify shared environment queries; they do
not assign exclusive renderer ownership. Performance snapshots include app
version, build mode, OS/architecture and native PID. The native startup clock is
recorded before desktop state initialization. Local diagnostic ZIPs embed the
exporting page's bounded renderer observations and memory series alongside the
native snapshot, so their separate capture timestamps remain inspectable.

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

Bootstrap also registers `worker_thread_artifact_review` for the main
workbench. The command resolves Thread context and delegates snapshot
operations; bootstrap does not own review state.

Browser annotation uses the registered `browser_annotate` command. Bootstrap
only forwards the typed input; native browser ownership, validation, temporary
DOM previews, and capture remain in `native_browser`.
