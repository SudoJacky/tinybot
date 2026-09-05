# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:e0db572676bbea1d701ae6bc3421cdfd0b275456a86824f4cdf1e8e2a710f751 -->

`chat` contains framework-independent chat and Thread contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

Persisted input references use `referenceKind` to distinguish ordinary file
attachments, managed images, referenced Threads, and browser evidence. Image references preserve their local path,
MIME type, byte size, and content hash through canonical timeline projection;
they never store an encoded payload.

The module does not render React views or invoke Tauri directly. Renderer code
consumes these interfaces from `react-workbench/chat`, while native transport
is isolated in `app-core/native` and workbench adapters.

`officeArtifact` recognizes only modern `.xlsx`, `.docx`, and `.pptx`
extensions and MIME types for local Artifact previews. Legacy and macro-enabled
formats remain unsupported, and conflicting extension/MIME evidence fails
explicitly instead of selecting the wrong parser. Its spreadsheet selection
contract carries the visible sheet, cell address, rendered value, and confirmed
change instruction from the Sidecar into Chat without moving composer behavior
into the domain module.

Canonical usage projection preserves cached input Token counts from both
normalized top-level fields and persisted Provider `prompt_tokens_details` or
`input_tokens_details` payloads, so historical and new Threads share one
cache-hit-rate contract. Typed top-level context-window metrics are merged with
that untouched Provider payload before the composer derives its usage indicator.

`turnMetrics.ts` derives first-call TTFT and weighted output speed from optional
`modelTiming` on canonical usage Items. Speed includes only samples with both
provider output counts and a positive decode duration. Old or non-streaming
Items supply no invented timings; a later call never replaces missing first-call
latency. Completed Turn duration uses the existing start and end timestamps.

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
