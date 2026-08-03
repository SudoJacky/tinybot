# Storage

`storage` contains small persistence utilities shared by backend modules.
`atomic.rs` provides atomic file replacement so callers do not expose partial
writes.
