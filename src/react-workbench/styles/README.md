# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:e18c56177077e68c7f03fdcb1fc02f370a3845fc41a976c8a74fc2ec8364bb60 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

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

The desktop document root is fixed to the WebView viewport and never owns page
scrolling. `html`, `body`, and `#root` contain the `100%` shell while route,
conversation, sidebar, and fatal-error surfaces own any required overflow. The
native window configuration remains the only minimum-size boundary; duplicating
its outer-window minimum on `body` would overflow the smaller inner WebView once
window chrome is subtracted.
