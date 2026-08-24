# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:4901629eec86a91fcae6a1977ee0bdb5d318c2d48de216534c42d8a042bc74b7 -->

`settings` owns framework-independent settings contracts, metadata, value
semantics, validation, pane models, and persistence patch construction.

It is the source of truth for secret handling, defaults, commit behavior, and
dirty/reconcile semantics. React pages present these models, while the desktop
Settings adapter performs native reads and writes.

Agent context-window defaults must remain aligned with the Rust runtime;
missing or cleared strategy values currently resolve to `compact`.

Custom provider patches declare `supportsReasoningEffort: true` by default and
preserve an explicit `false`, allowing the native request adapters to omit
effort for endpoints that reject it.
