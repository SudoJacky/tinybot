# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:27d8472b4181238bb1cfa3c6a8a3b1a9052a5202aa03cdbcb98922300e4b9a70 -->

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
cache-hit-rate contract. Typed top-level context-window metrics are merged with
that untouched Provider payload before the composer derives its usage indicator.

`desktopChatSessionController` requires every submission to name its target
Thread explicitly. The controller validates that target and never derives a
send destination from mutable active-session state, so the main Chat window
and the desktop pet quick-chat window can submit concurrently without routing
one surface's message into the other surface's Thread.

Submissions may also preserve an explicit `selectedTools` allowlist from the
composer. Omission keeps backend default tool exposure, while an explicit empty
list intentionally disables optional tools; this distinction survives the
desktop command boundary.

The main Chat composer and desktop-pet quick chat share one persisted reasoning
effort preference. A missing or invalid preference starts at `high`; an
explicit user selection remains authoritative across both surfaces.
