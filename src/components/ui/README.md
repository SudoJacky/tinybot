# Shared UI
<!-- tinybot-module-fingerprint: sha256:f26eb41a7153876cf4219d42bd3b65910700d51dc5113dfbaaa565e98d2b51b3 -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for ordinary Chat and controlled attachment state for native
entry points such as desktop-pet quick chat; both paths share selection limits,
removal, file-only submission, and successful-send clearing.
File drops and clipboard files use the injected `onImportFiles` adapter. Plain
text paste always inserts the full clipboard text into the current selection,
including long text and line breaks, instead of creating a separate attachment.
All editor variants keep pasted text editable and send it as ordinary draft
text through `onSendMessage(message, files, options)`. A nested-safe drop cue and import
status share the panel. Pending imports block sending and cannot attach to a
different `attachmentContextKey` after navigation.
File attachments and ordinary workspace file references use the shared
`FileAttachmentChip`: a single-line pill with a type icon, truncated filename,
fixed extension label, full-name/path/metadata tooltip, and remove action.
The row lives inside the composer panel and scrolls horizontally without widening
the input. Newly added files scroll into view; ordinary draft edits do not move
the row. Expanded annotation controls keep their existing editing behavior below it.
Route-owned context references can opt into an expanded annotation card with a
header, body value, and note while preserving the same remove and successful-send
clearing callbacks as compact references.
Model options may declare image-input support. The composer rejects newly
selected images for text-only models while retaining ordinary files, and an
existing incompatible image blocks sending after a model switch until the user
removes it or selects an image-capable model.
Its slash listbox combines route-provided executable commands with searchable
Skill options, including shared arrow-key, Enter/Tab, and Escape behavior.
Shift+Enter inserts a newline in plain-text editors, including while slash or
mention suggestions are open. Enter selects an active suggestion or sends the
draft with its internal line breaks preserved.
The inline editor renders a display-only trailing break after a terminal newline
so the blank line and caret remain visible without adding text to the draft.
Any slash immediately behind the caret starts or resets the active query; typing
continues filtering until the query is dismissed or the caret leaves it.
Selected Skills render as atomic removable tokens inline with editable user
text without placing Skill documents in the submitted message.

The device's App preference enables rich text by default. `MarkdownComposerEditor`
uses Tiptap to edit headings, emphasis, lists/tasks, quotes, code, links, and tables.
Pasted Markdown is parsed into an open document slice at the selection; ordinary
text joins the surrounding sentence. Clipboard HTML is not used. Image references
retain their Markdown without loading remote images. Drafts and submissions remain
Markdown strings, with serializer normalization after editing. Switching the setting
preserves the draft and structured attachments in both Chat and desktop quick chat.
The editor owns selection, IME, undo, and atomic Skill nodes. Menu queries use the
current text block instead of Markdown source offsets and stay inactive in code
blocks. Shift+Enter uses structural Enter to continue lists or split paragraphs;
Enter selects a suggestion or sends. Skills still travel as structured turn options.
The composer separates full control disabling from temporary send disabling,
so a route can preserve editable drafts while an asynchronous prerequisite is
still loading. A route-provided Tools list renders as checked controls and the
composer submits the complete explicit selection, including an intentional
empty selection. Tools discovered after mount are enabled by default without
overwriting prior user toggles. Its context-window indicator also presents the latest Provider
call's prompt-cache hit rate when cached and input Token counts are available,
and distinguishes a reported zero-percent hit from unavailable usage data.
Routes may advance the composer's `focusRequestId` after a contextual handoff;
the shared input then focuses the active editor and places the caret at the end
without stealing focus again on ordinary controlled-value updates.
Composer slash, mention, tool, and model menus use the workbench's shared
popover surface and item states while retaining their richer row layouts.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`useModalDialog` is the shared seam for modal focus, keyboard navigation,
background dismissal, focus restoration, and body scroll locking. Route-owned
dialogs keep their visual structure and domain actions local.

`useNativeSurfaceOcclusion` coordinates native child surfaces with shared overlay
semantics across routes and portals. Rendered modal dialogs block native surfaces
for their entire presence, including retained exit animation and nested dialogs.
Local menus, listboxes, dialogs, and `react-popover-surface` elements block only
intersecting surfaces. Hidden ancestors and inactive aria-hidden layers do not
block. Custom retained overlays declare `data-native-overlay="modal"` or `"local"`.
An exit layer keeps its marker until unmount and may use `data-state="closing"`
while already inert. No route-specific dialog flags enter native resource owners.
Mutation and resize observers track relevant overlay changes; finite overlay
motion is measured per frame, while unrelated streaming text does not trigger
geometry reads. Native hosts expose `data-occlusion` for inspection.

Browser annotation references share one compact count chip. Hover or focus
opens a viewport-bounded detail popover; click pins it for comment editing.
Escape and outside clicks dismiss it. Each entry shows a local crop, element
label, editable request, property differences, and removal. Raw evidence stays
out of the visible card. The portal participates in native-surface occlusion.
Context-reference images retain ordinary model image-input validation.
The composer and annotation preview share the `composerContextReference` data
contract so the preview does not depend on its parent input component. The input
module re-exports this type for callers using its public interface.
