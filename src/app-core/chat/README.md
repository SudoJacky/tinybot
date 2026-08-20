# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:355f2269e99e88279433125ed921e2499d4bcede8b680ef8f1f984405cc90bc9 -->

`chat` contains framework-independent chat and TinyOS contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.
