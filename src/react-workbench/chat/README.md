# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:e41ba50e373b3c1637b644a031c23c24f3d202f26a2ab0ca68d793d0e1c31f08 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.
`SessionSidebarResizeHandle` owns sidebar width and its drag lifecycle. Expanded
width defaults to 280 px and ranges from 220 to 420 px, with the maximum reduced
to reserve 480 px for the chat workspace where possible. Pointer movement updates
only sidebar geometry and the separator, without rerendering Chat content.
Dragging 48 px beyond the minimum invokes the existing collapse operation while
retaining pointer capture and focus. Dragging back to the minimum expanded width
reopens the sidebar and continues the same gesture, with a 48 px gap between the
two thresholds to prevent toggling near the boundary. Release while collapsed
retains the last saved expanded width. Completed expanded resize gestures persist
width in localStorage, while window constraints never overwrite the preference.
Escape, pointer cancellation, capture loss, blur, and unmount release the drag.
The separator supports arrow keys (8 px, or 32 px with Shift), Home/End, and
double-click reset. Tests cover persistence, bounds, cancellation, focus, and
render isolation.
Workspace session lists initially show six rows. Each workspace independently
reveals twelve rows on the first Show more click and all remaining rows on the
second. General chats and project member workspaces use the same behavior;
project coordinator rows remain fully visible. Search shows every matching row
and clearing it restores the previous reveal limit. Ordering uses the full list,
and keyboard moves across a reveal limit expand it to retain the focused row.
`useChatApplication.ts` coordinates submission, session data, turn commands,
active runtime effects, background subscriptions, and effective-capability
queries. The page supplies the selected session and composer context and receives
draft-consumed and background-activity notifications. Session replacement and
removal reconcile client state inside the application, independently of tab
animations. Background canonical updates load command acknowledgements without
replacing the active Timeline; obsolete loads and capability responses are
discarded when their session changes. Its tests exercise these workflows without
mounting page layout or Sidecar resources.
`chatSessionApplication.ts` owns session data, optimistic titles, per-draft
creation promises, persisted-ID reconciliation, metadata operations, and
Timeline-derived session status. `useChatSessions.ts` connects its snapshot and
semantic changes to React. The page owns tab selection, composer draft
persistence, scroll restoration, and temporary deleted-row animation snapshots;
it does not mutate the application's session data. Module tests cover concurrent
draft creation, ID/title reconciliation, deletion events, and visible failures.
`SidecarResources` owns Browser, Terminal, and Artifact state and lifecycle
coordination. The page holds only Sidecar layout presentation and invokes its
open/toggle operations; resource snapshots never enter page state.
`useChatSubmission.ts` owns submission preparation, model-save ordering,
optimistic message reconciliation, Artifact review capture, and compaction.
Session operations are supplied through semantic operations; the page supplies
composer selections and responds to consumed drafts. `desktopChatCommands.ts`
implements native Chat dispatch, model resolution, and canonical fork lookup,
leaving `defaultServices.ts` to wire its dependencies. Submission tests exercise
failure rollback and draft-ID reconciliation without mounting the page.
`chatTurnApplication.ts` owns per-session input queues, cancellation and
interrupt continuation, form commands, and transport/canonical command
confirmation with acknowledgement timeouts. It consumes Timeline snapshots;
the existing Timeline model remains authoritative for server state. Queue
submissions reserve their input before awaiting transport and remove only that
input on success, preserving concurrent queue edits. Failed submissions remain
visible and paused for manual retry.
`useChatTurnApplication.ts` adapts the application to React and keeps background
command errors scoped to their session. `ChatQueuedInputs.tsx` subscribes directly
to queue snapshots, so queue-only changes do not rerender the route's Timeline.
`chatTurnApplication.test.ts` verifies event ordering, duplicate delivery,
concurrent queue edits, failure handling, and per-session command confirmation
without mounting Chat or provisioning Sidecar resources.
`ChatPage.queue-rendering.test.tsx` verifies that deleting a queued input adds
neither a Timeline render nor a session-list request, and that browser snapshots
add no Timeline render while Chat and Sidecar share one native subscription.
The ChatPage details drawer retains closing content through a reversible 220 ms
opacity/transform transition using `lib/useExitPresence`. Closing immediately
makes the drawer inert and restores trigger focus; reopening cancels pending
removal. Thread changes clear incompatible details. Native Sidecar browser
visibility remains suppressed until the details drawer has fully left.
`ChatTimeline.tsx` owns the reusable canonical message and execution rendering;
its action callbacks are optional so read-only consumers can omit unavailable
branch, recovery, artifact, delegate, and tool-detail controls.
Assistant message actions belong only to a Turn's final answer; commentary in
the ordered execution trace remains readable but does not expose copy actions.
`TurnMetrics.tsx` places one elapsed-time pill beside final-answer actions, or
at the end of a failed/interrupted Turn without a final answer. It appears only
after the Turn ends. Clicking opens a viewport-clamped dialog with total time
and available TPS/TTFT readings; Escape restores trigger focus, and outside
pointer or Tab dismisses it. Old Turns show duration alone.
A running canonical execution trace starts expanded, then folds once when its
final answer first appears; completed traces therefore mount folded. A user can
still reopen the trace, and later streaming revisions preserve that explicit
choice. Its summary derives compact counts from semantic Step and Tool kinds,
and exposes running and abnormal status without logos. A folded Reasoning row
keeps elapsed time and content on one line. While streaming, its clipped preview
follows the latest text horizontally; completion returns to the beginning and
uses an ellipsis when the line does not fit. The user can expand the row for the
complete naturally wrapped text. Individual Tool and Diff rows also start
collapsed, so the ordered activity stays scannable until a user opens one row's
details.
`ChatDisclosureIcon.tsx` shares the leading icon and disclosure arrow across
Reasoning, Tool, Diff, Plan, compaction, and execution-summary headers. Their
triggers crossfade the icon to a down arrow on hover and keep an up arrow while
expanded, using the shared trigger's `aria-expanded` as the state source.
Keyboard focus and reduced-motion mode switch immediately; non-hover devices
keep the arrow visible.
`TimelineActivity.tsx` owns the shared Tool, Diff, Reasoning, Plan, compaction,
execution-summary, and legacy tool-group shell:
header layout, disclosure controls, stable accessible IDs, collapsed previews,
and the details region. Its CSS and the disclosure icon CSS are imported by
their owning modules. Ordinary tools use local expansion state; Reasoning and
Plan supply controlled `open` and `onOpenChange` values to preserve their own
streaming and completion rules. The `summary` slot stays visible when details
are collapsed, so plan progress remains readable. Details expand and collapse
with a reversible 200 ms grid-height and opacity transition. The grid follows
nested and streaming content without fixed-height measurement. Closing details
become inert and leave the accessibility tree immediately, then unmount once
their transitions finish; reopening cancels that pending unmount. Initially
open content does not animate on mount, and reduced motion switches immediately.
Details unmount by default;
tools and compaction opt into `keepMounted` to preserve their existing preview
lifecycle. Execution summaries also keep their children mounted so folding the
whole trace preserves individually expanded rows. Flat legacy tool groups use
the same list renderer without a disclosure shell. Business-specific renderers
own content and lifecycle decisions; they do not create disclosure buttons or IDs.
`FloatingPlanStatus.tsx` mirrors the most recent canonical plan across Turns in
a fixed top-right note without introducing another plan store. A newer Turn
without a plan keeps the previous plan visible; the next plan replaces it. New
plans and status revisions open the note briefly before it contracts to a
progress capsule; manual expansion stays open until the user closes it, and
reduced-motion mode replaces the slide with a short opacity transition. Normal
Turn completion keeps the last canonical plan state; failed or interrupted
Turns still reconcile unfinished steps to their terminal outcome.
`AssistantMarkdown.tsx` owns assistant prose and link presentation.
`ViewportContent` mounts expensive Markdown and chart bodies within 800 pixels
of the conversation viewport and releases them outside it. Lightweight message
and disclosure owners stay mounted, preserving their interaction state. Last
measured heights reserve space; plain text remains searchable while deferred.
Streaming, focused and selected content stays mounted. Keyboard focus can reveal
a placeholder. Scroll corrections preserve the visible anchor or bottom edge.
`conversationViewport` records a stable message anchor and local offset for
session switching, reveals that message before restoring the offset, and keeps
pixel-position restoration for snapshots without an anchor. Expanded chart
drawers stay mounted; inline chart tabs remain owned by `DataViewCard`.
Allowed web and email links keep their existing safe opener path while adding
an aria-hidden inline source icon: a GitHub mark for GitHub hosts, an envelope
for email, and a globe for other websites. The anchor remains inline so long
URLs can wrap with the surrounding Markdown text.
Local Markdown links are encoded before Streamdown's URL hardening and decoded
only by the file-link renderer. Clicking one asks Chat to open a contextual
Artifact resource; it never sends a local path through the external URL opener.
Chat normalizes relative paths, `file:` URLs, workspace absolute paths, and
optional line suffixes before requesting a Thread-scoped workspace read.

The desktop pet quick-chat surface composes `ChatTimeline` and
`ClaudeStyleAiInput` directly without mounting `ChatPage`. Its first submitted
draft creates an ordinary General Thread marked only with the `desktop-pet`
entry point. When that independent renderer hands a Thread to the main window,
`ChatPage` refreshes the native Thread list and activates the exact requested
session rather than inferring a target from the currently selected chat.

Chat projects the active session and Turn lifecycle into calm, curious, working,
angry, and pleased mascot moods, then reports that presentation state to the
desktop shell. It does not introduce a second source of truth for Agent status.
It also reports the active persisted session or local draft's working directory
so workspace-scoped resource routes retain the same context after Chat unmounts;
plugin-migration sessions remain unbound from that user workspace context.
`TinybotMascot` keeps the four-circle mark stable while its outer pose layers
transition between moods independently from the longer ambient loops. Classic
appearance uses the original flat fills; dimensional appearance adds only SVG
gradient lighting and restrained shadows. Reduced-motion mode preserves each
mood's static pose without transitions or looping animation.
Ambient mascot animation also pauses when the document or native pet preference
is hidden. Floating plan controls let the browser manage temporary compositor
layers instead of retaining a permanent `will-change` hint.

Chat contracts, commands, and projections live in `app-core/chat`. This folder
owns React state and presentation. Composer submission turns native managed
images into references with `referenceKind: "image"`. User attachments render as a
separate stack above the text bubble: managed images use the scoped Tauri asset
protocol for bounded previews, while ordinary files use compact metadata cards.
Published `tinybot.data_view.v1` artifacts keep their model-authored data and
view contract separate from presentation. Chat selects a matching Lieflat
Porcelain SVG template for supported line, area, bar, stacked, paired, and
waterfall data shapes. One shared blue luminance scale distinguishes series,
rank, and emphasis; mixed, dual-axis, and over-limit shapes retain an ECharts
SVG fallback using the same palette. `DataViewChart` chooses the template before
loading an engine: SVG templates render directly; `DataViewECharts` is imported
only for `mono-fallback`. `DataViewCard` owns the shared Suspense placeholder,
and import/render failures reach the existing application error boundary.
Both paths preserve the shared table, CSV,
expansion, and provenance controls, respect reduced motion, and never accept
renderer code from the model. Inline data views remain attached to their owning
tool step in the ordered execution trace instead of moving behind the final
assistant answer.
Pending Agent UI forms render below their canonical tool activity without
changing the persisted form schema. Multi-select and radio fields use native
inputs inside compact option cards so checked state, keyboard focus, and long
labels remain legible; a required multi-select cannot submit until at least one
option is checked.
Composer removal remains independent from this persisted timeline presentation.
The shared model catalog marks image-capable models for the picker. Selecting a
text-only model rejects new images and blocks an already attached image from
being sent until the user removes it or chooses a capable model.
The slash menu exposes only executable controls such as `/compact` plus the
Skills catalog for the active conversation working directory. Selecting a
Skill creates an atomic removable token inline with the user's editable text and submits its activation name
through `selectedSkills`; Rust resolves and injects the full Skill document
while assembling the native Turn request, so the visible user message remains
unchanged.
Chat header, session, composer, model, tool, and Sidecar resource menus share
the workbench popover shell and interaction states; scenario-owned CSS defines
only placement and rich-row layout.
Chat also maps the active workspace's callable catalog into composer tool
controls. Saved Agent Graphs appear only when the conversation has that exact
working directory. The submitted `selectedTools` list preserves every toggle,
including the explicit empty selection needed to disable optional tools.
Catalog availability, policy allowance, default selection, and current
composer selection remain separate states; opaque tool IDs are submitted
unchanged.
The composer context indicator derives its cache hit rate from the latest
projected Provider-call usage rather than cumulative Thread totals.
Before a Turn reports its effective per-model window, Chat uses the legacy
unknown-model fallback only as an initial display estimate; runtime usage then
becomes authoritative.
While the initial session list is loading, the composer keeps its draft editor
available but disables sending. The first Chat mount in each desktop app
lifetime ignores the persisted tab workspace and starts with an uncreated empty
conversation. User-facing new-chat actions also open a local draft session
without creating a native Thread. A pristine draft is removed when another
conversation is selected or Chat is left; a draft with composer text remains in
the local tab workspace and is restored on a later route mount. Opening another
draft materializes non-empty startup text as its own navigable local tab. The
first send materializes that draft with its captured workspace or project
context, replaces the local tab with the returned Thread ID, and only then
dispatches the Turn. Chat immediately shows a deterministic title derived from
the first prompt, but does not persist it through the manual-rename path. After
the durable Turn start, native code launches a separate tool-free request with
the same Provider and model; its eventual title update refreshes the session
list without delaying the main Turn. If title generation fails, the deterministic
title remains. A successful first send clears the draft under the returned Thread
ID; creation or dispatch failures reject the submission so the controlled composer
keeps the user's input.
The empty conversation continues to use the persisted composer model preference.
Changing its model uses the Settings-store default-model operation, which saves
the native Provider Profile/model pair before updating that renderer preference;
the first send waits for that persistence to complete.
Browser runtime snapshots are retained by the
session runtime and projected into Sidecar Browser resources. Each resource tab
maps to one native WebView2 tab in the Thread-scoped shared Browser Session, so user
input and Agent browser tools operate on the same tabs, profile, and navigation
state without a nested browser tab strip. Sidecar owns the user's selected
resource while native snapshots synchronize tab identity and content; the selected
resource then drives native activation without a reverse activation feedback loop.
Returning to a Thread with retained Browser resources reloads the authoritative
native snapshot before rendering its existing tabs.
Artifact file previews use the Thread ID rather than accepting a renderer-owned
workspace root. Rust resolves the recorded Thread working directory, falls back
to the configured default only for unbound conversations, and applies the
existing workspace traversal and symlink guards before reading one bounded text
chunk. For modern Office files, Chat uses that metadata revision to request a
bounded raw `.xlsx`, `.docx`, or `.pptx` payload and rejects the read if the
source changed. The Sidecar parses those bytes locally into sheet, continuous
document, or slide-list previews. Unsupported binary files, truncated text
previews, and read failures remain visible in the Artifact surface. Markdown
text is projected through the shared safe Markdown renderer as a document,
without exposing internal Artifact IDs or MIME metadata above the content. The
outer Artifact panel owns vertical scrolling for document and plain-text
previews, avoiding a second height-capped scroll region inside the Sidecar.
`useArtifactFile` observes only the visible local Artifact. It checks every three
seconds and on window focus/visibility restoration, passing `knownRevision` so
unchanged files do not reload content or reparse Office bytes. Each observer
owns its asynchronous reads; closing, hiding, or switching resources cancels
publication from old reads. Read failures retain the previous preview with a
visible error and recover on the next successful check.
Artifact previews can attach the whole resource to the composer without changing
the draft. Local references record the viewed revision and file path; later
refreshes leave already attached references unchanged.
Confirming a selected spreadsheet range's change request adds a visible,
removable file/range/current-value/request card above the composer and focuses
the editor without overwriting its existing draft. Chat keeps the structured
range annotation in route state and submits it as a source-text input reference,
so the Agent receives the file path, viewed revision, sheet, range, values, and requested
change even when the composer text is empty. Confirmation never sends a Turn
implicitly; a successful later send clears the annotation with other composer
context.
Creating sessions stay in the preparation state until WebView2 is ready, and
monotonic snapshot revisions prevent stale surface responses from hiding a newer
visible surface.

Docked Sidecar widths are persisted, then re-clamped against the measured Chat
workspace when the resource mounts or its container changes size. Desktop mode
preserves the minimum Chat column; narrow-window overlay mode preserves its
viewport gutter instead.

Sidecar Terminal resources are workspace-scoped rather than Thread-scoped.
Chat passes their stable resource ID, selected PowerShell or Command Prompt
shell, and workspace path to the typed native terminal adapter. Renderer
startup defers the xterm implementation until a Terminal resource is first
opened, with a localized pending state at that component boundary. Renderer
mounting never owns process termination: hiding Sidecar and switching tabs may
remount the xterm.js view, while only resource close invokes native terminate.
Regular chats share a stable default-workspace Sidecar scope; they omit the
terminal working-directory argument so Rust resolves the same configured
native default used by Agent turns.

Desktop-level project and workspace dialogs keep their domain actions in this
module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.

Session search stays inside the expanded sidebar instead of opening a desktop
dialog. The expanded-sidebar icon opens an auto-focused input; the collapsed
rail's search shortcut expands the sidebar into that same focused state. Search
filters session title, ID, and working-directory fields while preserving
matching workspace and project context. Closing with its button or Escape
clears the query, restores the full hierarchy, and returns focus to the search
trigger.

The first nonempty sidebar render may reveal at most three session rows with
0/30/60 ms delays and the shared 220 ms entrance. Search, row focus, selection,
reorder and refreshed grouping settle that one-shot entrance immediately;
clearing a search never replays it. Reduced motion keeps rows fully visible.

The expanded session sidebar keeps a renderer-local, versioned user order for
its top-level workspace/project blocks, each project's member workspaces, and
each block's own session list.
Dragging a session never changes its workspace or project membership. Workspace
headers and complete session rows are the drag sources; there is no separate
grip control. Their existing focus targets also support `Alt+ArrowUp` and
`Alt+ArrowDown`, and announce the result through a polite live region. Newly
discovered blocks and sessions appear ahead of a saved manual order; stale saved
IDs are ignored. Invalid persisted state is reported through the
`session-sidebar-order` diagnostic boundary before the sidebar returns to its
default grouping order. Session recency affects only the rows within a group.
Workspace groups follow registry order, with unregistered historical paths in
path order and General chats last; project groups and their member workspaces
follow their stored order. Manual ordering overrides these defaults.

The sidebar reads imported folders and their display names from the shared
`WorkspaceRegistryStore`. Choosing a folder registers it before creating a
workspace draft, so every new Thread receives the portable canonical path
returned by Rust rather than the file picker's raw Windows path. Rename changes
only the registry display name. An older in-flight registry snapshot cannot
replace a successful register, rename, or forget, so discarding a pristine
workspace draft does not remove its already registered folder. Empty registered
folders retain the same registry position as folders with sessions, so discarding
a draft cannot move its workspace to the bottom of the list. Forget removes
only the registry entry, leaves historical sessions and disk content intact,
disables new sessions from that historical group, and surfaces the backend error
when a project still references the workspace. Project-folder selection uses the
same register operation.
Sidebar workspace paths are available through header tooltips rather than a
second text line. Workspace and session titles share the same icon-column
alignment; session rows use an empty decorative slot and retain their trailing
timestamp/delete interaction.

The editable new-session empty state consumes that same registry through the
sidebar owner. Its heading defaults to General chats and exposes a keyboard
accessible workspace menu for choosing or registering a folder. Selection
updates only the local draft creation input, preserves any composer text already
entered, and reaches `SessionStore.create` on the first send. Persisted Threads
do not expose this picker because their creation-time workspace is immutable.
The empty-state heading reserves a viewport-scaled gap above the raised composer
to sit higher in the available space; narrow windows use a smaller bounded gap.
The workspace trigger uses a 1.4 line height so its ellipsis clipping preserves
letter descenders while keeping long names on one line.

Session creation follows the entry point's target. Workspace and project
actions capture their workspace and project context on the local draft. With the
session sidebar expanded, those contextual actions and the draft's first
submission are the primary creation paths; the compact rail exposes global new
chat and workspace shortcuts only while the sidebar is collapsed. Collapsed-rail,
menu, and keyboard
actions may inherit an ordinary active workspace, but never an active project
coordinator; coordinator sessions are created only by the project's coordinator
action. System-owned flows such as plugin migration continue to create their
required Thread immediately rather than entering the user draft lifecycle.

Composer model selection has two scopes. Selecting a model in a draft or an
empty Thread updates the default used by future chats as well as that Thread.
Selecting a model in a populated Thread updates only that Thread. Explicitly
creating another chat always resolves the saved new-chat default instead of
inheriting the model projected from the currently viewed populated Thread.

See the [Sidecar module contract](../sidecar/README.md) for resource scoping,
renderer ownership, native lifecycle boundaries, and verification entry points.

`ChatPage` behavior tests are grouped by interface area in
`ChatPage.<area>.test.tsx`: sessions, composer, Turn lifecycle, timeline,
messages, Sidecar, and styles. Shared route setup, native fakes, and stable
timeline builders live in `test/ChatPageTestHarness.tsx`; assertions and
behavior-specific fixtures remain in the owning test file.

`prepareArtifactReviews` saves original local Artifact bytes before actual
Turn dispatch, including queued inputs. Capture failures preserve the draft
and prevent dispatch. Explicit file references bind to their viewed revision;
ordinary uploads do not create review snapshots. Sidecar reloads the saved
review when a request is prepared and refreshes the live preview after restore.

Word and PowerPoint selections enter the existing Artifact reference composer
with their displayed revision, location and change instruction. Multiple
selection requests can coexist. Actual dispatch uses the same baseline capture
and source-revision checks as Excel; adding a request does not send it.

Windows file-link destinations retain their literal separators at the Markdown
destination compilation step, before CommonMark consumes punctuation escapes
such as `\.`. Ordinary prose and external URLs keep standard escaping. Link
activation logs both the decoded href and resolved workspace path for diagnosis;
the native workspace path guard remains authoritative.
