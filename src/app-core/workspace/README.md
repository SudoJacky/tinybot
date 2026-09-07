# Workspace Application Core
<!-- tinybot-module-fingerprint: sha256:cb5743b173844e1c28f7cafc18300c803c0d01cdef4717325d72550c820a1d5a -->

`workspace` defines the renderer-facing directory, file-chunk, pagination, and
structured workspace error contracts.
File chunks include an `unchanged` content type for conditional preview reads;
that response carries the revision and metadata without file content.

The module contains no filesystem access. Native I/O and result normalization
are implemented by the Workspace adapter behind the workbench store interface.
