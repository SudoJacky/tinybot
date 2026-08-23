# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:3b75a7530005aa8b78e0fa4717e120afacdd00c66a92499c1fdb1a9b699045b3 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.
`ChatTimeline.tsx` owns the reusable canonical message and execution rendering;
its action callbacks are optional so read-only consumers can omit unavailable
branch, recovery, artifact, delegate, and tool-detail controls.

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
Browser runtime snapshots are retained by the
session runtime and projected into Sidecar Browser resources. Each resource tab
maps to one native WebView2 tab in the Chat-owned shared Browser Session, so user
input and Agent browser tools operate on the same tabs, profile, and navigation
state without a nested browser tab strip. Sidecar owns the user's selected
resource while native snapshots synchronize tab identity and content; the selected
resource then drives native activation without a reverse activation feedback loop.
Returning to a Thread with retained Browser resources reloads the authoritative
native snapshot before rendering its existing tabs.
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

See the [Sidecar module contract](../sidecar/README.md) for resource scoping,
renderer ownership, native lifecycle boundaries, and verification entry points.

`ChatPage` behavior tests are grouped by interface area in
`ChatPage.<area>.test.tsx`: sessions, composer, Turn lifecycle, timeline,
messages, Sidecar, and styles. Shared route setup, native fakes, and stable
timeline builders live in `test/ChatPageTestHarness.tsx`; assertions and
behavior-specific fixtures remain in the owning test file.
