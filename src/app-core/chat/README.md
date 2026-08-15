# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:bb128637728af7c1f54a87a90c252f27a8559a36aa28815777e76b051c60befb -->

`chat` contains framework-independent chat and TinyOS contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.
