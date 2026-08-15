# Memory Route
<!-- tinybot-module-fingerprint: sha256:8e6475dc81dd646012508c0ed134f22cf9b4c4726f2c14c165f6d3f074c91492 -->

`memory` provides the lazy, read-only desktop view of Tinybot's active
long-term memory. It reads grouped snapshots through `MemoryStore` and owns the
route's loading, error, empty, and presentation states.

The canonical memory store, extraction, and consolidation pipeline remain in
the backend. This route does not add, update, or delete memories.
