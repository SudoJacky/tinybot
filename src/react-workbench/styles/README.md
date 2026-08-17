# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:6caf295e9b2356a38ab843521bb8b140e7daf15483b425f28f2fd0e70856fa1a -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, TinyOS, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
