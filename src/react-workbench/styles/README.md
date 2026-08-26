# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:e1be426badee7563916238861d4c5f54d9a05acbae55bc579200e72f1289cbc0 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

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
