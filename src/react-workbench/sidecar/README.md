# Sidecar
<!-- tinybot-module-fingerprint: sha256:31a96e79ab1f168743342eee22309de619e424381d89950b961282508b6436c0 -->

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
The resource menu reuses the global popover surface and item interaction states;
Sidecar CSS retains only its anchored placement and two-line resource layout.

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
Artifact tab. Chat presents Markdown Artifacts as rendered documents and keeps
the Artifact panel as the single vertical scrolling surface. Modern Office
files (`.xlsx`, `.docx`, and `.pptx`) are parsed locally into sheet, continuous
document, and slide-list previews; plain text, image, and data-view Artifacts
retain their type-specific previews. PowerPoint previews overlay a collapsed
left rail with one horizontal line per rendered slide; the current slide uses
a longer, higher-contrast line. Line strength and the expanded rows share a
smooth vertical pointer-proximity response, while the current slide remains at
full strength. Pointer hover or keyboard focus expands that rail into numbered
DOM-derived thumbnails without resizing the slide canvas; activating a
thumbnail scrolls the owning Artifact surface to the matching slide and marks
it current. Spreadsheet previews expose one selected
cell at a time with matching row and column headers, arrow-key navigation,
Escape clearing, and an explicit `Ctrl/Cmd+I` change request. Activating that
action opens a labelled input anchored below the selected cell; Enter or its
confirm button reports the sheet, address, rendered value, and trimmed request
through the render callback, while Escape cancels and restores cell focus.
Sidecar does not own or submit the Chat composer state.

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
  previews, spreadsheet change requests, and visible path-boundary failures.
- `OfficeArtifactPreview.test.tsx` covers spreadsheet selection, keyboard
  movement, the anchored change-request editor's confirm and cancel paths, and
  PowerPoint thumbnail-rail expansion and navigation.
- Run the [Windows desktop smoke test](../../../docs/guides/desktop-smoke-test.md)
  for real WebView2, PTY, process cleanup, and native geometry behavior.

## Related documentation

- [Chat workbench](../chat/README.md)
- [Native renderer adapters](../../app-core/native/README.md)
- [Native Browser runtime](../../../src-tauri/src/native_browser/README.md)
- [Desktop command reference](../../../docs/api/desktop.md)
