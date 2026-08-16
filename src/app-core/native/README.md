# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:a0e81a2426a85fba8314a66bab657e15795652f247599fba983fa001b97e7a47 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Settings, Plugins, Memory, or Performance Trace snapshots.

Adapters preserve native failures and normalize only their transport contract.
React state and product projections remain in the workbench and other app-core
modules. `nativeBackendContract` guards frontend/backend contract parity.

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
