# Thread Domain Types
<!-- tinybot-module-fingerprint: sha256:b10002d55d7d6f175ed8db5936d63d8aff9d83acb31e18bbf4115ff0d5af7e23 -->

This directory contains the shared data types for the thread domain. Types are
grouped into activity, events, items, persisted records, and requests, then
re-exported through `mod.rs`.
Generated-title results explicitly distinguish an applied update from a stale
result discarded because the source Turn or title ownership no longer matches.

Search requests optionally restrict results to user conversations. Responses add
`matches` (Thread, Turn and excerpt) and `hasMore` alongside the existing records.
