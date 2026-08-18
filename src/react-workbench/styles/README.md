# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:8afbef687e1012f0e0ef9bf31ceaec771fe449573cb73b9735cbe445c7b83d3a -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
