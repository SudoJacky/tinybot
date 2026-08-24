# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:66fb94ee9d39cb51a52290df4733fb693c65af9130bc5fb61f18708cdcff9836 -->

`chat` contains framework-independent chat and TinyOS contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

Persisted input references distinguish ordinary `tinyos.file` attachments from
managed `tinyos.image` attachments. Image references preserve their local path,
MIME type, byte size, and content hash through canonical timeline projection;
they never store an encoded payload.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.

Canonical usage projection preserves cached input Token counts from both
normalized top-level fields and persisted Provider `prompt_tokens_details` or
`input_tokens_details` payloads, so historical and new Threads share one
cache-hit-rate contract.

`desktopChatSessionController` requires every submission to name its target
Thread explicitly. The controller validates that target and never derives a
send destination from mutable active-session state, so the main Chat window
and the desktop pet quick-chat window can submit concurrently without routing
one surface's message into the other surface's Thread.
