# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:e5b97809d3eb1a37bf07b7778119a3b0070dfcacd23bdf4640bbff348860ec13 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
