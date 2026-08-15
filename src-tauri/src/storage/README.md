# Storage
<!-- tinybot-module-fingerprint: sha256:ff8fb22dcff82530974b15f930b621318d1142fd9b78a2024e69d2a2581b1295 -->

`storage` contains small persistence utilities shared by backend modules.
`atomic.rs` provides atomic file replacement so callers do not expose partial
writes.
