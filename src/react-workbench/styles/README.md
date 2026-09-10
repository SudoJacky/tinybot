# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:7d93a8a23a777f345d018a6e41645cd5ee4bdb8fd02011c6cdd6ffbefc92ba3b -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Update notes and upgrade notices use 13px body text, matching Chat. Their
Markdown selectors reach through the viewport wrapper, keeping compact headings
and list spacing effective in both the update prompt and saved release notes.

Session sidebar width uses a renderer-owned CSS variable. Its 8 px resize target
highlights on hover and focus, with increasing emphasis past the minimum width.
Its accent line supplies focus feedback instead of the browser's rectangular
outline around the full-height drag target.
The session scroller reserves the handle's gutter so its scrollbar remains usable.
Width transitions are disabled during expanded direct dragging. Collapse keeps
its existing motion and reduced-motion behavior while pointer capture remains
active. The collapsed rail hides the handle only after the gesture ends, so a
held drag can reverse direction and reopen the sidebar.

Workspace session reveal buttons align with session titles and use the sidebar's
muted text, row hover surface, and keyboard focus styling.
Session tab close controls use centered 32px targets, matching the
Chat header and Sidecar toolbar actions. Tab selection fills the available height
inside the 42px header without overflowing its bottom border.

Shared scrollbar tokens keep native overflow thumbs quiet against the current
theme, with stronger hover and drag states and transparent tracks. Desktop
WebViews use thumb-local pseudo-element styling; browsers without that support
use standard scrollbar colors on container hover. Route CSS must not set
`scrollbar-color` or a non-auto `scrollbar-width` for visible desktop scrollbars,
because those properties override the shared pseudo-element styling. Hidden tab
scrollers retain their existing rules, and forced-colors mode uses system styling.
The Sidecar terminal configures the equivalent states through xterm's slider
theme because its scrollbar is rendered by xterm rather than the browser.

Menu-like floating surfaces use `react-popover-surface` and
`react-popover-item` as the single visual authority for shell, selection,
hover, focus, checked, current, selected, and disabled states. Feature CSS may
add positioning, width, or rich-row layout without redefining that chrome.

The shared Lieflat Porcelain color roles live here so Profile usage charts,
Chat data-view SVG templates, and the ECharts fallback use one exact palette.
Their route-owned styles continue to define chart geometry and motion.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.

The desktop session sidebar uses workspace headers and complete session rows as
drag sources, with a grab cursor and high-contrast insertion line but no
separate grip control. Dragging lowers the source opacity while keeping its
footprint stable; reduced-motion mode retains these static state cues.
Session-row entrance styles apply only to the workspace's explicitly eligible
initial rows, with a bounded 30 ms stagger. Ordinary search/navigation never
inherits an entrance animation from the list container.
Its search action expands from the compact icon into a full-width inline input;
the outer search field stays 32px high including its border, with a 28px input
and close button, so toggling search never shifts the session rows vertically.
The mounted search layer reveals and retracts toward its trigger through reversible
160ms clip-path and opacity transitions; the default title controls crossfade in
the same fixed-height row. Focus-within styling keeps the active boundary visible,
and reduced-motion mode disables these transitions.
The collapsed sidebar is a 42px vertical shortcut rail matching the top bar's
height, with centered 32px buttons, 16px action icons, and a 24px mascot.
Its top control presents the Tinybot mascot at rest, then reveals the expand icon
on pointer hover or keyboard focus; new-chat, add-workspace, and search actions
follow in that order.
Workspace rename and forget actions stay compact beside the owning header and
use the same visible focus treatment as other sidebar controls. The workspace
row, rather than the native `details` content box, anchors a fixed right-aligned
two-button area so its create and manage actions cannot drop below the workspace
label.
Workspace and project headers show their icon and label without a separate
disclosure arrow. Native summary activation still toggles each group, and
workspace folder icons reflect the open or closed state.
Workspace, project, and session rows share a 36px minimum height, 8px corners,
and a 16px icon column. Session rows reserve that column with an aria-hidden
placeholder so their titles align with the workspace title. Project contents
keep one nesting inset. Light-theme selected sessions use a graphite surface and light text, distinct
from the subtle hover surface. Chat uses a near-white reading surface, while
the sidebar and Sidecar chrome use a cooler neutral surface. Reduced-transparency
mode keeps those opaque region colors.
Workspace and project headers highlight only on hover or keyboard focus, not
because they contain the active session.
Workspace paths appear only in header tooltips; nested workspace actions share
one trailing flex container to keep both buttons on the title line.
The session list keeps a 2px right inset beside its scrollbar and an 8px left inset.

The desktop document root is fixed to the WebView viewport and never owns page
scrolling. `html`, `body`, and `#root` contain the `100%` shell while route,
conversation, sidebar, and fatal-error surfaces own any required overflow. The
native window configuration remains the only minimum-size boundary; duplicating
its outer-window minimum on `body` would overflow the smaller inner WebView once
window chrome is subtracted.
