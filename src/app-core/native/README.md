# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:dff8c907ec2c7eb44d5e5907e426bf9daf48b4a2254ac44ff65081815f295916 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Terminal, Settings, Plugins, Memory, or Performance Trace
snapshots.

`desktopNativeAgentGraphs` implements the Graph store Interface through three
workspace-aware commands. The backend owns path validation, schema validation,
atomic writes, and revision conflicts; the Adapter only preserves the typed
definition and expected-revision contract.

`desktopNativeAgentGraphRuntime` lists application-owned Graph Runs and starts
one saved revision. The Rust Adapter owns preflight, standard Agent Thread
creation, output handoff, and atomic Run status updates.

`desktopNativeHooks` exposes the workspace-aware hook catalog and
exact-definition trust mutation. It sends only a workspace path, definition
hash, and requested trust state; command parsing and changed-definition checks
remain native responsibilities. Catalog snapshots also expose the generated,
never-overwritten commented configuration and script-template paths. Its
managed-hook save method sends the compact form draft and receives the refreshed
catalog. Test and archive methods address only the managed ID; sample creation,
execution policy, filesystem layout, and recoverable removal stay native
responsibilities. Script read and save methods are similarly ID-based and keep
path resolution, revision conflicts, and atomic writes behind the native
boundary.

Adapters preserve native failures and normalize only their transport contract.
React state and product projections remain in the workbench and other app-core
modules. `nativeBackendContract` guards frontend/backend contract parity.

`desktopNativeHostCommand` is a transitional retry adapter: it dispatches only
Chat `operation.retry` frames. Browser sessions remain a separate native
adapter so a later desktop surface can attach to the same WebView2 runtime used
by Agent web tools.

`desktopNativeTerminal` is the user-only Sidecar PTY adapter. It exposes only
typed PowerShell or Command Prompt creation plus poll, input, resize, and
terminate operations; callers cannot send an arbitrary process startup command
or address Agent shell sessions. Its create contract leaves the working
directory optional so a regular chat can use Rust's configured native default.

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
