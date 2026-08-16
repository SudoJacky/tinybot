# Workbench Styles
<!-- tinybot-module-fingerprint: sha256:bd4d5a81df324f4813521badcc93e3702bce72a9b1e03ce074c66bd31740f1d0 -->

`styles` contains the always-loaded design tokens, reset rules, accessibility
defaults, shared primitives, and desktop-shell styles.

Route-specific CSS is imported by its owning TypeScript module. Do not collect
Chat, TinyOS, Settings, Memory, or Tools styles here through `@import`, because
that would collapse their loading seams back into the startup bundle.
