# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:fd1537411fed7a61f1c420ab4557c360a3479b3a9671fe94ee09bd632a78f5ac -->

`shell` owns Tinybot's desktop chrome: the window frame, menus, route
selection, deferred route loading, and update dialogs.

`DesktopShell.tsx` coordinates shell state, while `RouteSurface.tsx` selects
the active route and preserves lazy seams for optional surfaces. Route-specific
behavior remains in the route module rather than moving into the shell.
