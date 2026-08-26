# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:4295862c1f31cc19e9c87d78e039c7394f9caf5e4a726c3c81ef30382c487cca -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Terminal, Settings, Plugins, Memory, or Performance Trace
snapshots.

`desktopNativeFilePicker` preserves the optional content hash returned for a
managed image. The native backend owns content detection and storage; the
renderer receives metadata and a managed path, never image bytes.

`desktopNativeAgentGraphs` implements the Graph store Interface through three
workspace-aware commands. The backend owns path validation, schema validation,
atomic writes, and revision conflicts; the Adapter only preserves the typed
definition and expected-revision contract.

`desktopNativeAgentGraphRuntime` lists application-owned Graph Runs and starts
one saved revision by Graph identity plus the required transient input. Input
nodes store no prompt in the reusable definition. The Rust Adapter owns
preflight, standard Agent Thread creation, output handoff, and atomic Run status
updates.

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
`desktopNativeCommandPermissions.test` keeps the registered Tauri handler list,
the build-time application-command manifest, and window-scoped permission sets
in lockstep. It also pins the quick-chat webview to its bounded chat command
subset while leaving the pet webview without application-command access.

`desktopNativePet` is the seam between the main renderer and the Windows-only
`desktop-pet` webview. Its host synchronizes one state snapshot, owns the
ready/probe handshake, native size and monitor placement, and settled move
events. The lightweight pet renderer client exposes only state listening,
native window dragging, keyboard movement, and size or visibility requests.
Neither side creates a second application service graph.

`desktopNativePetQuickChat` owns the typed event handshake between the pet,
main renderer, and independent `desktop-pet-chat` webview. The main host alone
positions, presents, and focuses the native panel; the pet sends a bounded
draft plus validated attachment metadata, and the quick-chat window can hand an
explicit Thread ID back to the main Chat route or start native dragging from
its title bar. `desktopNativePetFileDrop` owns the Windows WebView2 result
handshake, request timeout, and strict metadata parsing. Main-window handoff
shows, restores, and focuses `main` before dispatching the route event. Invalid
or oversized payloads fail at these Adapter boundaries.

`desktopNativeHostCommand` is a transitional retry adapter: it dispatches only
Chat `operation.retry` frames. Browser sessions remain a separate native
adapter so a later desktop surface can attach to the same WebView2 runtime used
by Agent web tools.

`desktopNativeTerminal` is the user-only Sidecar PTY adapter. It exposes only
typed PowerShell or Command Prompt creation plus poll, input, resize, and
terminate operations; callers cannot send an arbitrary process startup command
or address Agent shell sessions. Its create contract leaves the working
directory optional so a regular chat can use Rust's configured native default.

`desktopNativeWorkspace` exposes both default-workspace browsing and a
Thread-scoped file-chunk request for contextual Artifact previews. The latter
sends only `threadId`, path, and optional cursor; Rust remains responsible for
selecting the canonical Thread workspace and enforcing its filesystem bounds.

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
export results used by the System > Performance Trace route. It saves JSON
snapshots through the native desktop file dialog instead of relying on WebView
download behavior. It also merges the small, always-retained renderer startup
trace into the native snapshot without persisting ordinary info logs, and
passes the current renderer log snapshot plus allowlisted locale metadata to
the diagnostic-bundle exporter. Invalid metrics, events, or result shapes fail
at the native boundary instead of being partially rendered.

`desktopUpdateNotes` persists the last available update's version, publication
time, Release Notes, and custom display notes in renderer storage. The update
dialog uses this validated record for System > What's New after an installer
restart has cleared the process-local native update snapshot.
