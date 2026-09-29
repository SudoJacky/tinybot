# Rollout Format
<!-- tinybot-module-fingerprint: sha256:8d7f6c0fd8f251f4f83da9895c4de9910678e301b9c3baf810f735144833b015 -->

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

Tool-output projection keeps string and structured-part content, represents null
as empty text, and serializes numeric, boolean, and object results as JSON text.
The original output remains unchanged in native replay records.

Replay recovers an omitted `request_user_input` result from an explicit matching
form cancellation in older Rollouts, in both provider protocols. Existing results
take precedence; unmatched calls still fail normal runtime validation. Recovery
changes the reconstructed context only and leaves the canonical log untouched.
