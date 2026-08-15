# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:6fd43cc811ee3fd2e2c59e9253ecb3fb9be0a5866531ccd373dec59aaa92bc8d -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, TinyOS, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
