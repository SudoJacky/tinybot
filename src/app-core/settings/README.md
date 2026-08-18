# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:e36f03201c441ca6792e095bd9b934cd146857a7c3dbf11e50993095f4b1b515 -->

`settings` owns framework-independent settings contracts, metadata, value
semantics, validation, pane models, and persistence patch construction.

It is the source of truth for secret handling, defaults, commit behavior, and
dirty/reconcile semantics. React pages present these models, while the desktop
Settings adapter performs native reads and writes.

Agent context-window defaults must remain aligned with the Rust runtime;
missing or cleared strategy values currently resolve to `compact`.
