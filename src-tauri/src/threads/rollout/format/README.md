# Rollout Format
<!-- tinybot-module-fingerprint: sha256:58e830ab56434c46cdc4782f0e0cce7d51f999b2f04d8f3cb5b50f96d421ab82 -->

`format` defines the versioned records written to thread rollout files and the
rules for rebuilding thread state and transcripts from those records.

Persistence policy is kept here so writers and readers agree on which runtime
items belong in the durable history.

Replay recovers an omitted `request_user_input` result from an explicit matching
form cancellation in older Rollouts, in both provider protocols. Existing results
take precedence; unmatched calls still fail normal runtime validation. Recovery
changes the reconstructed context only and leaves the canonical log untouched.
