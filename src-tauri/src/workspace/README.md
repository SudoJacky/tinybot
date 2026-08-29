# Workspace Service
<!-- tinybot-module-fingerprint: sha256:a9b75b94c7e28ed1bfb5fbe46cc0b1a324ea9ab9e4588fa8c5e0c342bf79961a -->

`workspace` provides capability-checked operations within the active workspace.
It handles safe path resolution, file reads and writes, directory inspection,
skill discovery, allowlisted bootstrap-file batch reads, and patch application.

The raw-byte read used by modern Office Artifact previews reuses the same path
containment boundary, enforces the caller's byte cap before allocation, and may
bind the read to an expected file revision so source changes fail explicitly.

All filesystem operations must remain inside the configured workspace root.
Bootstrap reads report missing allowlisted files separately, while inspection
or read failures remain explicit errors rather than being treated as absence.
Agent and Worker callers use the shared capability-checked write, delete, and
patch operations.
