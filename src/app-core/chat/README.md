# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:7d50f8c24df124e1f4359f0c5b7b7e8b051284ccf92fdbe1a63b96f72263e7de -->

`chat` contains framework-independent chat and TinyOS contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.
