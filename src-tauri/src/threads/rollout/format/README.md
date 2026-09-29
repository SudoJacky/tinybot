# Rollout Format
<!-- tinybot-module-fingerprint: sha256:9aa2e2a58b79ff99a9b2060e5b81a88826524e474cac31205b9c963b76c39045 -->

`format` defines the versioned records written to thread rollout files and the
rules for rebuilding thread state and transcripts from those records.

Persistence policy is kept here so writers and readers agree on which runtime
items belong in the durable history.

Model-context reconstruction preserves structured content and each message's
Thread, Turn, message identity, and original Rollout ordinal. Transcript
projection alone flattens content for display. Historical system/developer
instruction filtering belongs to this reconstruction boundary; current Turn
instructions are supplied separately. Forks and context checkpoints retain the
source identity of copied messages, while generated summaries link to their
context checkpoint.

Replay recovers an omitted `request_user_input` result from an explicit matching
form cancellation in older Rollouts, in both provider protocols. Existing results
take precedence; unmatched calls still fail normal runtime validation. Recovery
changes the reconstructed context only and leaves the canonical log untouched.
