# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:a6e61822b1c263edd4278ba178130cd800216e7e93cc1618a5f9861e16e8de36 -->

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
