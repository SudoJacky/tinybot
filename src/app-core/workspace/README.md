# Workspace Application Core
<!-- tinybot-module-fingerprint: sha256:5568450ee16ddc61670d0b39d239bfd62aadcbf5a35269e9abdfa119c5102f71 -->

`workspace` defines the renderer-facing directory, file-chunk, pagination, and
structured workspace error contracts.

The module contains no filesystem access. Native I/O and result normalization
are implemented by the Workspace adapter behind the workbench store interface.
