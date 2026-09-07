# Workspace Application Core
<!-- tinybot-module-fingerprint: sha256:a34f22c9b5dbd6a17c2385a5b9181ab23e6deae6e8690512ece7a137cf376e15 -->

`workspace` defines the renderer-facing directory, file-chunk, pagination, and
structured workspace error contracts.
File chunks include an `unchanged` content type for conditional preview reads;
that response carries the revision and metadata without file content.

The module contains no filesystem access. Native I/O and result normalization
are implemented by the Workspace adapter behind the workbench store interface.

`artifactReview.ts` defines the baseline, comparison and resolution contract.
Review state is pending, accepted or restored. Native storage owns snapshots;
the renderer receives bytes only when the user requests comparison. Resolution
requires both the review ID and the exact compared content hash.
