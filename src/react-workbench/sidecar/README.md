# Sidecar
<!-- tinybot-module-fingerprint: sha256:94da717a2717b797ea99dbe6ebb7e6b013c9d814471f56676fc4fe81707e5b3d -->

`sidecar` owns the React resource shell displayed beside Chat. It presents
thread-scoped Browser and Artifact resources, workspace-scoped Terminal
resources, their tab selection, and the docked, hidden, or expanded Sidecar
layout.

The module owns renderer state and presentation only. Chat provisions and
releases native resources, the native Browser runtime owns WebView2 sessions
and tabs, and the desktop Terminal runtime owns user PTY processes. Sidecar
must not become a second authority for either native lifecycle.

## Resource model

`sidecarModel.ts` defines the reducer and the stable resource identities used
by Chat:

- Browser resources belong to the current Thread and bind one-to-one to native
  WebView2 tabs in that Thread's shared Browser Session.
- Artifact resources belong to the Thread that produced the Artifact.
- Terminal resources belong to the active workspace. Regular conversations
  share `DEFAULT_SIDECAR_WORKSPACE_ID`, which asks Rust to resolve Tinybot's
  configured default workspace rather than inventing a renderer path.
- Changing scope retains resources in memory but exposes only resources owned
  by the current Thread or workspace.

Creating a resource selects it and reveals Sidecar. Closing a selected resource
chooses the next visible resource, then the previous one, and finally no active
resource. The reducer removes renderer state; the Chat owner performs any
required native Browser close or Terminal termination before dispatching the
close event.

## Presentation and lifecycle

`Sidecar.tsx` owns tabs, the resource menu, keyboard tab behavior, and the
resize handle. Width is persisted separately from resource state. The live and
restored width is clamped against the measured Chat workspace: docked mode
preserves the minimum Chat column, while narrow overlay mode preserves a
viewport gutter.

`SidecarBrowser.tsx` renders Browser chrome and coordinates visible-surface
attachment with the native Browser adapter. It does not render remote page
content in React. Browser snapshots are authoritative for native session and
tab identity. Chat guards activation so a snapshot update cannot create a
reverse activation feedback loop.

`SidecarTerminal.tsx` attaches xterm.js to the dedicated user-only native PTY
adapter. Chat loads this terminal surface on demand and Sidecar presents a
bounded pending state while its code chunk arrives, keeping xterm out of the
main startup bundle. Mounting and unmounting the React view never terminate the process:
hiding Sidecar and switching resources may remount the view, while closing the
resource invokes termination through Chat. Terminal input is serialized with
polling so cursor-based output cannot be reordered.

Artifact presentation is supplied by Chat through the Sidecar render contract;
Artifact domain state does not live in this module. Artifact tabs may come from
canonical Agent artifacts or from local file links in assistant Markdown. File
links are contextual only, so the resource menu does not create an empty
Artifact tab.

## Invariants

- One visible Sidecar Browser resource maps to one native Browser tab.
- Browser and Artifact visibility follows Thread scope; Terminal visibility
  follows workspace scope.
- Direct user Browser input and Agent Browser actions share native state, but a
  newer user control epoch invalidates stale Agent work.
- User Terminal processes, input, output, and lifecycle are isolated from Agent
  shell tools.
- Hiding Sidecar or switching tabs preserves native resources; closing a
  resource releases the native resource through its Chat owner.
- Persisted widths cannot force Chat or the resource surface outside the
  current workspace bounds.
- Resource provisioning failures remain visible and retryable rather than
  being represented as an empty successful surface.
- Local file Artifact reads use the recorded Thread workspace and retain the
  native workspace path guard; the renderer cannot nominate an arbitrary root.

## Verification

- `sidecarModel.test.ts` covers resource identity, scoping, Browser snapshot
  synchronization, selection, close behavior, and width bounds.
- `Sidecar.test.tsx` covers resource creation, tabs, keyboard behavior, menus,
  and measured resizing.
- `SidecarBrowser.test.tsx` covers navigation, surface visibility, protected
  handoff, and Browser failure states.
- `SidecarTerminal.test.tsx` covers PTY creation, ordered input and polling,
  reattachment, resize, and renderer disposal without termination.
- `../chat/ChatPage.sidecar.test.tsx` covers Chat-owned provisioning, Browser
  activation, session reattachment, workspace fallback, and close-time cleanup.
- `../chat/ChatPage.timeline.test.tsx` covers assistant file-link Artifact
  previews and visible path-boundary failures.
- Run the [Windows desktop smoke test](../../../docs/guides/desktop-smoke-test.md)
  for real WebView2, PTY, process cleanup, and native geometry behavior.

## Related documentation

- [Chat workbench](../chat/README.md)
- [Native renderer adapters](../../app-core/native/README.md)
- [Native Browser runtime](../../../src-tauri/src/native_browser/README.md)
- [Desktop command reference](../../../docs/api/desktop.md)
