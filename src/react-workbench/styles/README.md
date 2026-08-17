# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:5b347488cfa180130c641564d04053c36665b8608b5298c6a8d443c6590ba4b5 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, TinyOS, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
