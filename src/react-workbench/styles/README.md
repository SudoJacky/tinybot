# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:12234348f39cb4d54c32d6231b221193b0e27125b81cd8292663996d90ea80c3 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
