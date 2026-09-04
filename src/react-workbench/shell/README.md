# Desktop Shell
<!-- tinybot-module-fingerprint: sha256:efedecee5d19387062a8851bdc60d44a398d0e0964b577bd2464e5aa9ed37248 -->

`shell` owns Tinybot's desktop chrome: the window frame, menus, route
selection, deferred route loading, and update dialogs.

`DesktopShell.tsx` coordinates shell state, while `RouteSurface.tsx` selects
the active route and preserves lazy seams for optional surfaces. Route-specific
behavior remains in the route module rather than moving into the shell.
The shell also marks only the first Chat mount in an app lifetime as a fresh,
uncreated conversation. Once Chat finishes session hydration, later route
remounts can restore the tabs opened during that same app lifetime.
The shell retains the active Chat working directory across route unmounts and
passes it to workspace-scoped MCP, callable Tool, and Agent Graph discovery in
Tools & Plugins. That route independently requests its Skill inventory across
all imported workspaces; Chat Skill selection remains scoped to the retained
active directory. The shell does not derive that current selection from
session recency or project-group order.
Shell menu and keyboard new-chat commands only signal Chat to open a local
draft; they do not create a native Thread before the draft's first send.
Session search is entirely owned by Chat's sidebar and no longer routes command
recommendations or route-navigation callbacks through the desktop shell.
Shell menu surfaces and items use the shared workbench popover primitives, so
route-owned menus can reuse the same visual and focus states without copying
shell-specific selectors.
The Help menu stays single-level and exposes only working actions:
Documentation, Report an issue, and Tinybot repository open through the same
system URL opener, while Keyboard shortcuts targets that module inside the
Settings route. The shell carries the requested Settings module across the
route's deferred-loading boundary instead of maintaining a Help placeholder
route or a disabled secondary menu. Repository navigation lives only in Help
instead of being duplicated in Resources.

Resources > Agent Graphs opens a dedicated lazy route. The shell knows only the
route label, loader, and shared renderer stores passed to it; workspace catalog
derivation, Graph draft state, and Run presentation remain under `agent-graph/`
and do not become a Chat mode.
The Resources menu has no standalone Workspace Files route; contextual file
previews remain owned by Chat's Artifact sidecar.

The shell owns the Tinybot desktop pet's three-step size preference, classic or
dimensional appearance, visibility, desktop position persistence, and current
mascot mood. It passes the same preference callback into the Appearance route,
the browser fallback, and the native snapshot so previews and both pet hosts
cannot drift. On Windows, it
synchronizes that state through `app-core/native/desktopNativePet` to the
independent `desktop-pet` Tauri window; browser-only development retains the
bounded inline adapter. `DesktopPetWindow.tsx` owns only rendering and direct
window interaction, while Chat only reports the current mascot mood. The pet
can be hidden from its own controls without duplicating Agent lifecycle state
or booting a second `App` service graph. The always-accessible Appearance page
owns visibility, size, style, and the command that resets an off-screen pet to
the current safe default without changing its other preferences; native and
browser-fallback hosts both apply that reset immediately.

The pet accepts external HTML5 `text/plain` and `Files` drops. It forwards text
unchanged and asks the native Adapter to import local files before sending a
versioned quick-chat request to the independent `desktop-pet-chat` window.
`DesktopPetQuickChatWindow.tsx` reuses Chat's canonical composer, attachment
submission, and timeline presentation; dropped attachments remain removable,
and the composer file picker uses the same native importer. It keeps the draft
editable, exposes the same model picker and context-token usage, and persists
model changes to the selected Thread. The picker receives the same enabled-model
catalog and image-input capabilities as the main Chat route, so unsupported
images are blocked consistently. Its initial context display uses the
unknown-model fallback until runtime usage reports the effective per-model
window. It lazily creates a standard Thread on
first send without workspace or project metadata. Opening an existing recent
chat or handing the new Thread to the main window always carries its explicit
Thread ID; `DesktopShell` refreshes the main renderer's session list before
activating it. Pointer-down on the panel title bar starts native window
dragging, while the open and minimize controls remain ordinary buttons.

The bounded `react-route-surface` owns vertical overflow for document-like
routes so long settings, tools, and diagnostics pages remain scrollable inside
the fixed desktop window frame. Full-height routes such as Chat can continue to
own their more specific inner scroll regions without moving the window frame.

The System menu links to Settings and the lazily loaded Performance Trace
route. The shell owns only navigation; metrics, process-memory recording,
recent events, refresh, and export behavior remain under `performance/`.

Update dialogs retain update lifecycle state in the shell and reuse
`components/ui/useModalDialog` for desktop-level modal interaction behavior.
System > What's New reopens the validated latest update record persisted by
`app-core/native/desktopUpdateNotes`, while automatic update prompts continue
to render the live native updater snapshot.
