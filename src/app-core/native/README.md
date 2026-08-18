# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:fbd248b86c71aa58c468de7aa2dc1bd10ed663625a2555a3f9715f0c13d9ab56 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Settings, Plugins, Memory, or Performance Trace snapshots.

Adapters preserve native failures and normalize only their transport contract.
React state and product projections remain in the workbench and other app-core
modules. `nativeBackendContract` guards frontend/backend contract parity.

`desktopNativeHostCommand` is a transitional retry adapter: it dispatches only
Chat `operation.retry` frames. Browser sessions remain a separate native
adapter so a later desktop surface can attach to the same WebView2 runtime used
by Agent web tools.

`rendererLogger` is the renderer-wide observability entry point. It emits
structured `debug`, `info`, `warn`, and `error` events to the console and a
300-entry in-memory ring. Debug events remain behind
`tinybot.desktop.nativeDebug`; warnings and errors are always sent to the
native backend log when Tauri is available. Enabling diagnostic mode also
persists renderer debug and info events while a problem is reproduced. The
logger centrally bounds nested
context and redacts credentials, tokens, prompts, and request or response
bodies. Renderer crash diagnostics keep their specialized local fallback but
use the same structured backend collector.

`desktopNativePerformanceTrace` validates the versioned, bounded snapshot and
diagnostic-bundle export result used by the System > Performance Trace route.
It passes the current renderer log snapshot and allowlisted locale metadata to
the native exporter. Invalid metrics, events, or result shapes fail at the
native boundary instead of being partially rendered.

`desktopUpdateNotes` persists the last available update's version, publication
time, Release Notes, and custom display notes in renderer storage. The update
dialog uses this validated record for System > What's New after an installer
restart has cleared the process-local native update snapshot.
