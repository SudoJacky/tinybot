# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:b8ef95011a65d898fc481b3ca72d37cac206d3b00528b3ba18c70325c689196d -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
