# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:0cfb2b93f54c964c589bb503fb93657cf06c948caf3fdeae26840096b3771e1f -->

`settings` owns framework-independent settings contracts, metadata, value
semantics, validation, pane models, and persistence patch construction.

It is the source of truth for secret handling, defaults, commit behavior, and
dirty/reconcile semantics. React pages present these models, while the desktop
Settings adapter performs native reads and writes.
