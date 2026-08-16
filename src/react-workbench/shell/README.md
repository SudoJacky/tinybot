# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:003829223a8e0ea6ecbbc12265ae9179313fc9b3ab1cbcb23cc12b301259c7ce -->

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
