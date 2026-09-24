# Token usage ledger
<!-- tinybot-module-fingerprint: sha256:58625edf36b401e22949f65cdd380b323d3091a47c56319bc28cf8fe8f03e072 -->

The parent `token_usage.rs` owns provider-field normalization, the SQLite
connection and global daily/model totals. This directory adds attribution and
invocation history to that same authority, rather than deriving another counter
from runtime events or replayed transcripts.

- `attribution.rs` scopes trusted purpose and Team/task/attempt/Thread/Turn IDs.
  Canonical Thread identities resolve from the existing session index; parent
  lineage restores Team attribution after detached execution or restart.
- `recording.rs` owns logical requests and separately identified retry attempts.
  Each begins pending before execution. Dropped futures become interrupted;
  process crashes leave pending records with an explicitly uncertain outcome.
- `ledger.rs` atomically completes invocations and updates daily totals. Exact
  duplicate completions are idempotent; conflicting completions are errors.
  Snapshot reads use one transaction. History uses a descending rowid cursor,
  at most 100 requests per page, optionally filtered to a Team run.
- `ledger_tests.rs` covers migration, concurrent duplicates, pagination, real
  HTTP retries, storage failures, and planner/task/detached-child/background
  attribution reconciled against the global totals.

Purpose distinguishes conversation, Team planning/execution, subagents,
automation, compaction, title generation, memory extraction/consolidation, and
Graph routing/execution. Owned async provider/tool tasks explicitly carry their
scope. Background extraction resolves its saved Thread/Turn; consolidation
starts with a fresh unallocated origin because it may combine multiple sources.

Migration freezes previous aggregates once as `legacy`, with no invented request
counts or Team attribution. Missing usage is null, distinct from reported zero.
Cached input and reasoning output remain subsets; non-cached input is derived
as input minus cached input. These fields are not added again to total tokens.
Storage failures are observable and returned, never silently ignored. Records
contain identities and counts, not prompts, responses, credentials, or prices.
