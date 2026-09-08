# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:8f082b9d7fb54042b397a8bdec0b2e18324586ddabc5e76146db9e36a9b3b210 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Terminal, Settings, Plugins, Memory, or Performance Trace
snapshots.

`rendererPerformance` installs one bounded observer set at the entry module for
resources, long tasks, paint and slow interaction events. Each stream retains
120 recent samples and the 20 slowest lifetime samples, plus aggregates and eviction counts. Export includes page
identity, time origin, navigation milestones, capability/error status and an
optional browser heap estimate. Resource URLs retain bundled asset names, allowlisted source-module paths or
Vite dependency names; other paths use origin categories. Queries, remote URLs
and absolute workspace paths are excluded. Resources include initiator type
and request/response timing offsets (zero means unavailable). Slow
event samples use a 40 ms threshold and are not an INP calculation. Observations
belong to the exporting page and are included in JSON snapshots and local ZIPs.
Memory normalization also preserves optional window dimensions and child WebView
labels, including windows with multiple WebViews; older snapshots remain readable.

`desktopNativeFilePicker` preserves the optional content hash returned for a
managed image. The native backend owns content detection and storage; the
picker returns metadata and a managed path. Its browser File importer sends
one raw binary IPC body at a time, with a base64 UTF-8 filename header, and
receives the same metadata contract. Browser imports are limited to 32 MiB per
file before bytes are read; native errors retain their filename and detail.

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
`desktopNativeConfigPatch` flattens public settings patches into canonical
replace/remove operations; the explicit remove marker lets optional paired
settings such as the Memory Provider/model override return to inherited values.
Dynamic MCP server and header names use JSON Pointer removal paths so dots in
user-owned keys cannot be mistaken for configuration path separators.
`desktopNativeCommandPermissions.test` keeps the registered Tauri handler list,
the build-time application-command manifest, and window-scoped permission sets
in lockstep. It also pins the quick-chat webview to its bounded chat command
subset while leaving the pet webview without application-command access.

`desktopNativePet` is the seam between the main renderer and the Windows-only
`desktop-pet` webview. Its host synchronizes one state snapshot, owns the
ready/probe handshake, native size and monitor placement, and settled move
events. First placement and explicit position reset use the bottom-right of
the main window client area, with a 12-physical-pixel inset, then clamp to its
monitor work area. Reset recalculates current bounds even when the persisted
preference is already unset; ordinary startup preserves manually saved positions. The lightweight pet renderer client exposes only state listening,
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

`desktopNativeThreads` owns typed Thread reads, runtime-state queries,
effective-capability queries, correlated form resolution, and operation retry.
Browser sessions remain a separate native adapter so another desktop surface
can attach to the same WebView2 runtime used by Agent web tools.

`desktopNativeTerminal` is the user-only Sidecar PTY adapter. It exposes only
typed PowerShell or Command Prompt creation plus poll, input, resize, and
terminate operations; callers cannot send an arbitrary process startup command
or address Agent shell sessions. Its create contract leaves the working
directory optional so a regular chat can use Rust's configured native default.

`desktopNativeWorkspace` exposes default-workspace browsing plus Thread-scoped
file-chunk and raw-byte requests for contextual Artifact previews. Chunk requests
can include `knownRevision` for conditional refreshes. The raw-byte
request sends only `threadId`, path, and the optional metadata revision; Rust
remains responsible for selecting the canonical Thread workspace, enforcing
its filesystem bounds and size limit, and rejecting changed sources.

`desktopNativeWorkspaceRegistry` is the typed transport seam for the global
workspace catalog. It exposes only list, register, rename, and forget; path
canonicalization, Windows verbatim-prefix removal, persistence, migration, and
project-reference checks remain in Rust.

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
validates `tinybot.memory_snapshot.v1` from both the full-snapshot and
memory-only commands. Diagnostic export passes optional bounded memory samples,
the current renderer log snapshot, and allowlisted locale metadata to the
native exporter. Invalid metrics, memory counters, events, or result shapes
fail at the native boundary instead of being partially rendered.

`desktopUpdateNotes` persists the last available update's version, publication
time, Release Notes, and custom display notes in renderer storage. The update
dialog uses this validated record for System > What's New after an installer
restart has cleared the process-local native update snapshot.

`performanceMemoryRecording` retains an opt-in recording per performance store,
independent of route subscribers. It samples serially, two seconds after each
completed collection, and stops at 300 samples or on failure. Stopping or
restarting discards late results; page navigation preserves the baseline.

`desktopNativeWorkspace.artifactReview` invokes the Thread-scoped native
review command with a discriminated action. It forwards expected revisions
for capture/compare and exact content hashes for keep/restore; it does not
select snapshot paths or an alternative workspace root.
