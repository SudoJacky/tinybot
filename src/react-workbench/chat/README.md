# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:ca6d2891fc9dc67e6a2dbf39c1efedc72cc6229bc24066fe5ac93d606c797d30 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.
`ChatTimeline.tsx` owns the reusable canonical message and execution rendering;
its action callbacks are optional so read-only consumers can omit unavailable
branch, recovery, artifact, delegate, and tool-detail controls.
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

Chat contracts, commands, and projections live in `app-core/chat`. This folder
owns React state and presentation. Composer submission turns native managed
images into typed `tinyos.image` references. User attachments render as a
separate stack above the text bubble: managed images use the scoped Tauri asset
protocol for bounded previews, while ordinary files use compact metadata cards.
Composer removal remains independent from this persisted timeline presentation.
The slash menu exposes only executable controls such as `/compact` plus the
Skills catalog for the active conversation working directory. Selecting a
Skill creates an atomic removable token inline with the user's editable text and submits its activation name
through `selectedSkills`; Rust resolves and injects the full Skill document
while assembling the native Turn request, so the visible user message remains
unchanged.
The composer context indicator derives its cache hit rate from the latest
projected Provider-call usage rather than cumulative Thread totals.
Before a Turn reports its effective per-model window, Chat uses the legacy
unknown-model fallback only as an initial display estimate; runtime usage then
becomes authoritative.
While the initial session list is loading, the composer keeps its draft editor
available but disables sending. The first Chat mount in each desktop app
lifetime ignores the persisted tab workspace and starts with an uncreated empty
conversation. Later route remounts may restore tabs opened during that same app
lifetime. The empty conversation continues to use the persisted composer model
preference, and changing its model updates that preference for future chats.
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
chunk. Unsupported binary files, truncated previews, and read failures remain
visible in the Artifact surface.
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

Session creation follows the entry point's target. Workspace and project
actions pass their workspace and project context explicitly. Global, tab, and
search actions may inherit an ordinary active workspace, but never an active
project coordinator; coordinator sessions are created only by the project's
coordinator action.

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
