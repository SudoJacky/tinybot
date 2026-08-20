# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:b980e62f1ad3abb4671ee3403d81fc5b2ce04c164db01f715eda65bfd8675992 -->

`shell` owns Tinybot's desktop chrome: the window frame, menus, route
selection, deferred route loading, and update dialogs.

`DesktopShell.tsx` coordinates shell state, while `RouteSurface.tsx` selects
the active route and preserves lazy seams for optional surfaces. Route-specific
behavior remains in the route module rather than moving into the shell.

Resources > Agent Graphs opens a dedicated lazy route. The shell knows only the
route label, loader, and shared renderer stores passed to it; workspace catalog
derivation, Graph draft state, and Run presentation remain under `agent-graph/`
and do not become a Chat mode.

The shell also owns the floating Tinybot desktop pet's viewport position,
three-step size preference, visibility, and local persistence. Chat only reports
the current mascot mood. The pet can be hidden from its inline controls and
restored from the System menu without duplicating Agent lifecycle state.

The bounded `react-route-surface` owns vertical overflow for document-like
routes so long settings, tools, and diagnostics pages remain scrollable inside
the fixed desktop window frame. Full-height routes such as Chat can continue to
own their more specific inner scroll regions without moving the window frame.

The System menu links to Settings and the lazily loaded Performance Trace
route. The shell owns only navigation; metrics, recent events, refresh, and
export behavior remain under `performance/`.

Update dialogs retain update lifecycle state in the shell and reuse
`components/ui/useModalDialog` for desktop-level modal interaction behavior.
System > What's New reopens the validated latest update record persisted by
`app-core/native/desktopUpdateNotes`, while automatic update prompts continue
to render the live native updater snapshot.
