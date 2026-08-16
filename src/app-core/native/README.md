# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:33bc7e4fad16b58ac420087f6fec9242b2b6027b1254fcc852f17c8c0a2a5746 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Settings, Plugins, Memory, or Performance Trace snapshots.

Adapters preserve native failures and normalize only their transport contract.
React state and product projections remain in the workbench and other app-core
modules. `nativeBackendContract` guards frontend/backend contract parity.

`rendererLogger` is the renderer-wide observability entry point. It emits
structured `debug`, `info`, `warn`, and `error` events to the console and a
300-entry in-memory ring. Debug events remain behind
`tinybot.desktop.nativeDebug`; warnings and errors are also sent to the native
backend log when Tauri is available. The logger centrally bounds nested
context and redacts credentials, tokens, prompts, and request or response
bodies. Renderer crash diagnostics keep their specialized local fallback but
use the same structured backend collector.

`desktopNativePerformanceTrace` validates the versioned, bounded snapshot used
by the System > Performance Trace route. Invalid metrics or event shapes fail
at the native boundary instead of being partially rendered.
