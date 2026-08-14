# Rollout Format
<!-- tinybot-module-fingerprint: sha256:3b9f3d8c1c3e7482043b0ff39a27c88b3a0880f982f2f784c39a1d195520ca52 -->

`format` defines the versioned records written to thread rollout files and the
rules for rebuilding thread state and transcripts from those records.

Persistence policy is kept here so writers and readers agree on which runtime
items belong in the durable history.
