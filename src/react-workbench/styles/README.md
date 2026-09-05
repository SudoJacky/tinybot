# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:c9f8cb6375b0777d081b74559b3fdf921dff5f68730d4e630c98448528e3d41e -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

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
Its search action expands from the compact icon into a full-width inline input;
focus-within styling keeps the active boundary visible and reduced-motion mode
shortens the reveal through the shared global motion rule.
The collapsed sidebar is a vertical shortcut rail. Its top control presents the
Tinybot mascot at rest, then reveals the expand icon on pointer hover or keyboard
focus; new-chat, add-workspace, and search actions follow in that order.
Workspace rename and forget actions stay compact beside the owning header and
use the same visible focus treatment as other sidebar controls. The workspace
row, rather than the native `details` content box, anchors a fixed right-aligned
two-button area so its create and manage actions cannot drop below the workspace
label.

The desktop document root is fixed to the WebView viewport and never owns page
scrolling. `html`, `body`, and `#root` contain the `100%` shell while route,
conversation, sidebar, and fatal-error surfaces own any required overflow. The
native window configuration remains the only minimum-size boundary; duplicating
its outer-window minimum on `body` would overflow the smaller inner WebView once
window chrome is subtracted.
