# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:7d962e9235b50fe998805968c0cf16a31b102269454c9f0ec209968c009e6731 -->

`shell` owns Tinybot's desktop chrome: the window frame, menus, route
selection, deferred route loading, and update dialogs.

`DesktopShell.tsx` coordinates shell state, while `RouteSurface.tsx` selects
the active route and preserves lazy seams for optional surfaces. Route-specific
behavior remains in the route module rather than moving into the shell.

The bounded `react-route-surface` owns vertical overflow for document-like
routes so long settings, tools, and diagnostics pages remain scrollable inside
the fixed desktop window frame. Full-height routes such as Chat can continue to
own their more specific inner scroll regions without moving the window frame.

The System menu links to Settings and the lazily loaded Performance Trace
route. The shell owns only navigation; metrics, recent events, refresh, and
export behavior remain under `performance/`.

Update dialogs retain update lifecycle state in the shell and reuse
`components/ui/useModalDialog` for desktop-level modal interaction behavior.
