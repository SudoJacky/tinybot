# Sidecar
<!-- tinybot-module-fingerprint: sha256:ea53ec7c790a9c4fd7a343ec9e7363853d219953236e07a29f31d0be16d71f2e -->

Tabs retain a 150px width and scroll horizontally with the mouse wheel while hiding the scrollbar. Horizontal trackpad gestures and Ctrl-wheel zoom remain native. Activating a tab reveals its whole container, including Close; the unused More control is omitted.

`sidecar` owns the React resource shell displayed beside Chat. It presents
thread-scoped Browser and Artifact resources, workspace-scoped Terminal
resources, their tab selection, and the docked, hidden, or expanded Sidecar
layout.

The module owns renderer state, presentation, and resource lifecycle coordination.
`SidecarResources.tsx` provisions and
releases native resources, the native Browser runtime owns WebView2 sessions
and tabs, and the desktop Terminal runtime owns user PTY processes. Sidecar
must not become a second authority for either native lifecycle.

`useSidecarBrowserState.ts` owns native Browser snapshots and revision ordering.
It shares one native event subscription with Chat through `chatEventSource`;
Browser updates do not enter the Chat runtime state. The page receives only
presentation geometry and explicit requests to reference content or resume Chat.

## Resource model

`sidecarModel.ts` defines the reducer and the stable resource identities used
by `SidecarResources`:

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
resource. The reducer removes renderer state; the resource owner performs any
required native Browser close or Terminal termination before dispatching the
close event.

## Presentation and lifecycle

The Sidecar header is 42px tall including its bottom border; the Chat session
bar is 36px tall. Resource tab selection fills the available header height.

`ImageArtifactPreview` displays local raster files proportionally and reports
decode errors. `CodeArtifactPreview` reuses chat syntax highlighting, themes,
wrapping and copying; copy preserves the original file text. Unknown text
formats retain plain previews.

`Sidecar.tsx` owns tabs, the resource menu, keyboard tab behavior, and the
resize handle. Width is persisted separately from resource state. The live and
restored width is clamped against the measured Chat workspace: docked mode
preserves the minimum Chat column, while narrow overlay mode preserves a
viewport gutter.
Direct pointer, keyboard and viewport-clamp width updates are immediate; the
ephemeral reducer `layoutMotion` policy restores the 220 ms grid transition
when presentation changes. Only numeric width is persisted.
The shell stays mounted but inert while hidden so its layout can transition in
either direction. React content remains until its grid/overlay exit finishes;
the shell also keeps its last visible presentation during that exit so an
expanded panel does not snap back to docked width on close.
Reopening invalidates pending removal, and changing owner scope or active tab
discards incompatible retained content. Browser native visibility becomes false
immediately on logical close, independently of retained React chrome. Hiding
does not terminate browser or terminal resources.
Native Browser surfaces use the shared overlay coordinator: global modals hide
the surface regardless of position, and local popup surfaces hide it only on
intersection. Nested and closing overlays keep it hidden until none remain.
Only native presentation changes; tabs, navigation, and resources remain alive.
Hiding is reported immediately, while restoration uses the existing settling
delay and latest layout revision. `data-occlusion` reports `modal` or `overlap`.
The shell and Chat no longer pass individual menu or drawer visibility flags.
The resource menu reuses the global popover surface and item interaction states;
Sidecar CSS retains only its anchored placement and two-line resource layout.

`SidecarBrowser.tsx` renders Browser chrome and coordinates visible-surface
attachment with the native Browser adapter. It does not render remote page
content in React. Browser snapshots are authoritative for native session and
tab identity. `SidecarResources` guards activation so a snapshot update cannot create a
reverse activation feedback loop.

`SidecarTerminal.tsx` attaches xterm.js to the dedicated user-only native PTY
adapter. `SidecarResources` loads this terminal surface on demand and Sidecar presents a
bounded pending state while its code chunk arrives, keeping xterm out of the
main startup bundle. Mounting and unmounting the React view never terminate the process:
hiding Sidecar and switching resources may remount the view, while closing the
resource invokes termination through `SidecarResources`. Terminal input is serialized with
polling so cursor-based output cannot be reordered.

The default docked width is 520px; explicit saved widths remain respected.
CSV and TSV files render as bounded tables (200 rows, 50 columns) with a source
switch, row/column counts, and the existing reference-in-chat action. Extension
recognition also handles files reported as text/plain. Parsing preserves quoted
fields and numeric precision; malformed data produces a visible, logged error
and leaves the original source available. File metadata is collapsed below the
preview. File refreshes and revision-bound references use the existing lifecycle.

Artifact presentation is supplied by Chat through the Sidecar render contract;
Artifact domain state does not live in this module. Artifact tabs may come from
canonical Agent artifacts or from local file links in assistant Markdown. File
links are contextual only, so the resource menu does not create an empty
Artifact tab. Sidecar presents Markdown Artifacts as rendered documents and keeps
the Artifact panel as the single vertical scrolling surface. Links inside a
local Markdown preview carry that document's resolved path, so relative links
resolve from its containing directory. Chat-message links retain their workspace
base, absolute targets keep their own paths, and native workspace authorization
remains authoritative. Link diagnostics record the source document, original
href, and resolved target together. Modern Office
files (`.xlsx`, `.docx`, and `.pptx`) are parsed locally into sheet, continuous
document, and slide-list previews; plain text, image, and data-view Artifacts
retain their type-specific previews. PowerPoint previews overlay a collapsed
left rail with one horizontal line per rendered slide; the current slide uses
a longer, higher-contrast line. Line strength and the expanded rows share a
smooth vertical pointer-proximity response, while the current slide remains at
full strength. Pointer hover or keyboard focus expands that rail into numbered
DOM-derived thumbnails without resizing the slide canvas; activating a
thumbnail scrolls the owning Artifact surface to the matching slide and marks
it current. Spreadsheet previews expose rectangular cell selections through
dragging, Shift-click, or Shift-arrow navigation, with matching row and column headers,
Escape clearing, and an explicit `Ctrl/Cmd+I` change request. Activating that
action opens a labelled input anchored below the selected cell; Enter or its
confirm button reports the sheet, normalized range address, rendered values, and trimmed request
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
  resource releases the native resource through its Sidecar resource owner.
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
- `../chat/ChatPage.sidecar.test.tsx` covers Sidecar-owned provisioning, Browser
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

`ArtifactReviewPanel` loads the native review state and offers comparison,
keeping the current version, and restoring the baseline. File revisions
invalidate displayed comparisons; keep and restore are disabled during Agent
generation. Excel comparisons list cell value changes and added/removed sheets,
showing at most 200 changes with a full count (up to one million visited cells).
They do not verify formulas, formatting or charts. Text versions show the first
32 KB, while Word and PowerPoint reuse read-only previews. Restore always uses
the complete saved bytes. These controls acknowledge or replace the live local
file; they are not a staged edit, history browser or finalization workflow.

`OfficeContentEditor` captures native text ranges wholly within its owning
preview. Word uses preview paragraph positions and nearby paragraph text;
PowerPoint uses slide positions and also supports the active entire slide,
including slides without text. Ctrl/Cmd+I opens the request editor and Escape
cancels it locally. Source replacement or rerendering invalidates unfinished
selections. Comparison previews omit these controls. Each Office render owns
its DOM target so a late renderer cannot replace newer visible content.

## Browser annotation workspace

The address-bar action starts element selection. `BrowserAnnotationWorkspace`
anchors a compact comment editor near the selection; a toggle expands its
scrollable property controls without resizing the native viewport. A serialized
command queue coordinates selection, live previews, capture, and the native
window exclusion for the trusted renderer editor. It uses a labelled group,
not a generic occluding dialog. Hiding or unmounting stops annotation.

`BrowserAnnotationImage` displays a frozen viewport capture with a draggable
crop selection. Only the selection and floating comment remain; there are no
annotation toolbars or drawing modes. The address-bar toggle and Escape still
exit annotation. SVG coordinates map to the captured CSS viewport, and image
export accounts for pixel density. Attaching imports a PNG through
managed file storage, restores the native preview, and then reports the
reference to Chat. Import failures keep the draft; stale asynchronous imports
cannot attach to a later workspace. Tests cover restoration-before-attachment,
import failure, unmount cleanup, and late completion.
Element attachments crop the capture to the selected element plus 12 CSS pixels
of context; region attachments retain the user-selected bounds. Reference
titles describe the element and details list only changed properties. Full
inspection state remains in the workspace rather than the composer attachment.

Attaching clears temporary edits and the current draft while keeping annotation
mode available for another element. Switching elements resets the comment;
explicit parent selection preserves it. Finish releases native ownership, as
does the awaited `finishBrowserAnnotation` handoff before composer submission.

The comment anchor stays fixed across expansion, collapse, and live style changes.
Its handle supports pointer dragging and arrow keys; resizing clamps the anchor
and limits the scrolling controls to the available space. Native clip updates
coalesce drag frames while a previous update is in flight.
`AnnotationStyleEditor` owns editable drafts, numeric scrubbing and units,
percentage sliders, color and alpha controls, and linked or independent spacing
sides. Invalid CSS stays visible and blocks attachment until corrected. Collapsing
preserves drafts; reset or a new selection remounts them. Tests cover anchoring,
dragging, units, alpha, percentages, linked spacing, and validation recovery.
