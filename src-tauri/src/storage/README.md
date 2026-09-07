# Storage
<!-- tinybot-module-fingerprint: sha256:1146b0fe1383099604d0f9d80c7cf34f588f53bd2c8ed3eb82595caf44ab2b01 -->

`storage` contains small persistence utilities shared by backend modules.
`atomic.rs` provides atomic file replacement so callers do not expose partial
writes.

The checked byte writer lets callers validate the current target immediately
before replacement, after writing and syncing the temporary file. A failed
check leaves the target untouched. Windows replacement resolves the parent
to a verbatim absolute path so both new and existing long paths work.
