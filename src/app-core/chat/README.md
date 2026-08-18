# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:8cd2e9385021281bf9d49e07ae7b1282bfc04ee8b0277c691585b165f576127a -->

`chat` contains framework-independent chat and TinyOS contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.
