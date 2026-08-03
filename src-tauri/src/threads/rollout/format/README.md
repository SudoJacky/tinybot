# Rollout Format

`format` defines the versioned records written to thread rollout files and the
rules for rebuilding thread state and transcripts from those records.

Persistence policy is kept here so writers and readers agree on which runtime
items belong in the durable history.
