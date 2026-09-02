# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:ecbbcef60e163c34ca0e93bf465f894e7fb50be6b55e64b986399bd154123042 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.
`ChatTimeline.tsx` owns the reusable canonical message and execution rendering;
its action callbacks are optional so read-only consumers can omit unavailable
branch, recovery, artifact, delegate, and tool-detail controls.
Every canonical execution trace starts expanded and keeps the user's explicit
fold choice across live timeline revisions. Its summary derives compact counts
from semantic Step and Tool kinds, exposes running and abnormal status without
logos, and never renders reasoning content. Individual Tool and Diff rows start
collapsed, so the ordered activity stays scannable until a user opens one row's
details.
`FloatingPlanStatus.tsx` mirrors the most recent canonical plan across Turns in
a fixed top-right note without introducing another plan store. A newer Turn
without a plan keeps the previous plan visible; the next plan replaces it. New
plans and status revisions open the note briefly before it contracts to a
progress capsule; manual expansion stays open until the user closes it, and
reduced-motion mode replaces the slide with a short opacity transition. Normal
Turn completion keeps the last canonical plan state; failed or interrupted
Turns still reconcile unfinished steps to their terminal outcome.
`AssistantMarkdown.tsx` owns assistant prose and link presentation.
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
`TinybotMascot` keeps the four-circle mark stable while its outer pose layers
transition between moods independently from the longer ambient loops. Classic
appearance uses the original flat fills; dimensional appearance adds only SVG
gradient lighting and restrained shadows. Reduced-motion mode preserves each
mood's static pose without transitions or looping animation.

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
SVG fallback using the same palette. Both paths preserve the shared table, CSV,
expansion, and provenance controls, respect reduced motion, and never accept
renderer code from the model. Inline data views remain attached to their owning
tool step in the ordered execution trace instead of moving behind the final
assistant answer.
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
dispatches the Turn. A successful first send clears the draft under the returned
Thread ID; creation or dispatch failures reject the submission so the controlled
composer keeps the user's input.
The empty conversation continues to use the persisted composer model preference.
Changing its model uses the Settings-store default-model operation, which saves
the native Provider Profile/model pair before updating that renderer preference;
the first send waits for that persistence to complete.
Browser runtime snapshots are retained by the
session runtime and projected into Sidecar Browser resources. Each resource tab
maps to one native WebView2 tab in the Chat-owned shared Browser Session, so user
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
Confirming a selected spreadsheet cell's change request adds a visible,
removable file/range/current-value/request card above the composer and focuses
the editor without overwriting its existing draft. Chat keeps the structured
cell annotation in route state and submits it as a source-text input reference,
so the Agent receives the file path, sheet, address, current value, and requested
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

Desktop-level project and session-search dialogs keep their domain actions in
this module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.

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
natural recency order.

Session creation follows the entry point's target. Workspace and project
actions capture their workspace and project context on the local draft. With the
session sidebar expanded, those contextual actions and the draft's first
submission are the primary creation paths; the tab-strip create action appears
only while the sidebar is collapsed. Collapsed-tab, search, menu, and keyboard
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
