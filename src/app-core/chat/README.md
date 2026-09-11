# Chat Application Core
<!-- tinybot-module-fingerprint: sha256:a8b5ad63f6e3e81fba7a96c548faa7fc548a5150092aaf0b2b582d1ce36dd52c -->

`chat` contains framework-independent chat and Thread contracts, command
construction, canonical timeline validation, UI projection, input state, and
desktop session coordination.

`providerRetryStatus` validates transient provider status updates and correlates
them with a Thread, Turn, and model call. It never infers failures from assistant text
or adds retry notices to the canonical timeline.

Persisted input references use `referenceKind` to distinguish ordinary file
attachments, managed images, referenced Threads, and browser evidence. Image references preserve their local path,
MIME type, byte size, and content hash through canonical timeline projection;
they never store an encoded payload.

`agentTimelineModel` caches each published snapshot. An accepted Item patch
reprojects only its Turn, retaining unchanged historical Turn references and
inserting the changed Turn into canonical start order. Live Item revisions can
advance without changing the durable snapshot revision, so cache invalidation
tracks Item-array changes rather than the durable revision alone. Duplicate or
stale patches reuse the snapshot; full loads replace the cache. Hook results are
projected on load because Item patches do not change runtime events.
`agentTimelineModel.performance.test.ts` checks a 250-Turn history under 30
streaming updates and reports elapsed projection time without a timing gate.

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
Optional first-call `timeToRequestMs` is preserved separately from TTFT, including
zero. Missing old readings remain unavailable and invalid numeric readings fail
canonical validation instead of being substituted from a later invocation.

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

`officeContentReference` formats Word paragraph and PowerPoint slide selections
as version-bound local file references. It preserves the quote, surrounding
context, preview positions and requested change, with explicit excerpt limits.
Preview paragraph positions are not original XML indices; the Agent must locate
the quoted passage in the source rather than replacing every matching string.

Browser image references may carry `sourceText` for page evidence and
`userAnnotation` for the explicit user-authored request. Keep these fields
separate so page content cannot become a user instruction. Managed image
metadata is retained without persisting screenshot data URLs.

Data-view parsing matches native publication for row IDs: any unique nonblank
string is accepted and preserved verbatim, including Unicode names and numeric
prefixes. Column and source references retain their identifier constraints.
