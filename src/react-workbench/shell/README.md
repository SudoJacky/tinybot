# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:d06a5da88127f762f76b4e6eb03c97a6125594aa41cee1192195213f02c19b81 -->

`shell` owns Tinybot's desktop chrome: the window frame, menus, route
selection, deferred route loading, and update dialogs.

`DesktopShell.tsx` coordinates shell state, while `RouteSurface.tsx` selects
the active route and preserves lazy seams for optional surfaces. Route-specific
behavior remains in the route module rather than moving into the shell.

The System menu links to Settings and the lazily loaded Performance Trace
route. The shell owns only navigation; metrics, recent events, refresh, and
export behavior remain under `performance/`.
