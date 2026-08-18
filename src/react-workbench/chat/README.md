# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:430564e6e12aae742d36cac24e201fe50e573ce6e55513e65a4beef98a68dd34 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.

Chat contracts, commands, and projections live in `app-core/chat`. This folder
owns React state and presentation. Browser runtime snapshots are retained by the
session runtime and projected into Sidecar Browser resources. Each resource tab
maps to one native WebView2 tab in the Chat-owned shared Browser Session, so user
input and Agent browser tools operate on the same tabs, profile, and navigation
state without a nested browser tab strip. Sidecar owns the user's selected
resource while native snapshots synchronize tab identity and content; the selected
resource then drives native activation without a reverse activation feedback loop.
Creating sessions stay in the preparation state until WebView2 is ready, and
monotonic snapshot revisions prevent stale surface responses from hiding a newer
visible surface.

Sidecar Terminal resources are workspace-scoped rather than Thread-scoped.
Chat passes their stable resource ID, selected PowerShell or Command Prompt
shell, and workspace path to the typed native terminal adapter. Renderer
mounting never owns process termination: hiding Sidecar and switching tabs may
remount the xterm.js view, while only resource close invokes native terminate.

Desktop-level project and session-search dialogs keep their domain actions in
this module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.
