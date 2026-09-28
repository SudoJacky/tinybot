# Shared UI
<!-- tinybot-module-fingerprint: sha256:66ec7b09dc1bbbd14ba4836dd24a5feb542e6e9d5c01c6616bc8af1380462aed -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for standalone consumers and controlled attachment state for
Chat session drafts and desktop-pet quick chat; both paths share selection limits,
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
`composerContracts.ts` defines shared Skill options, cursor reports, and semantic
editor operations (`focusEnd` and `replaceTrigger`). `PlainComposerEditor` owns
textarea and inline DOM selection, IME, paste, and atomic Skill positions;
`MarkdownComposerEditor` owns the equivalent Tiptap behavior and undo history.
The input owns menus, attachments, and submission without inspecting editor DOM.
Rich-text menu queries use the
current text block instead of Markdown source offsets and stay inactive in code
blocks. Shift+Enter uses structural Enter to continue lists or split paragraphs;
Enter selects a suggestion or sends. Skills still travel as structured turn options.
The composer separates full control disabling from temporary send disabling,
so a route can preserve editable drafts while an asynchronous prerequisite is
still loading. The composer has no Tools button or per-tool toggles. Submission
forwards the optional `mcpEnabled` boolean supplied by its route, preserving
explicit false and omitting it when unspecified. The route resolves catalog
availability and permissions before passing this value. The composer never
sends a `selectedTools` allowlist. Its context-window indicator also presents the latest Provider
call's prompt-cache hit rate when cached and input Token counts are available,
and distinguishes a reported zero-percent hit from unavailable usage data.
Routes may advance the composer's `focusRequestId` after a contextual handoff;
the shared input then focuses the active editor and places the caret at the end
without stealing focus again on ordinary controlled-value updates.
Composer slash, mention, and model menus use the workbench's shared
popover surface and item states while retaining their richer row layouts.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`LiquidToggle` is the shared on/off switch for Settings, Plugins, and MCP. It
accepts native checkbox props (including controlled `checked`/`onChange`, labels,
and disabled state), or owns its value when only `defaultChecked` is supplied.
`speed` and `stretch` range from 0 to 100 and default to 50 and 36. Its
velocity-driven spring motion is adapted from Bencho's MIT Liquid Toggle, with
the original notice retained in the source and distributed in
`public/assets/licenses/bencho.txt`. Native label and Space activation
remain intact; `role="switch"` also supports Enter. Keyboard activation and
reduced motion settle immediately, including a live preference change. The
animation follows confirmed props and never commits an asynchronous setting.

`LiquidSegmentedControl` presents short, stable single-choice sets in a capsule.
It uses controlled native radios with independent group names, arrow-key navigation,
disabled options, and a visible focus ring. Its active pill and `LiquidToggle`
share `useLiquidMotion`: a spring with velocity-driven stretch, immediate keyboard
selection, and live reduced-motion handling. Percentage travel tracks equal-width
segments across resizing and font changes without measuring the layout.

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

The optional `teamAvailable` composer prop adds an `@team` capability choice.
Selection inserts literal text in both plain and rich editors, without attaching
another conversation. The backend interprets the submitted Team token.
