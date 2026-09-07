# Workspace Service
<!-- tinybot-module-fingerprint: sha256:1f563538121e2febb39b234de79bb528e2780bc42c86f898d2c7b2f84e37a877 -->

`workspace` provides capability-checked operations within the active workspace.
It handles safe path resolution, file reads and writes, directory inspection,
skill discovery, allowlisted bootstrap-file batch reads, and patch application.

The raw-byte read used by modern Office Artifact previews reuses the same path
containment boundary, enforces the caller's byte cap before allocation, and may
bind the read to an expected file revision so source changes fail explicitly.
Conditional chunk reads accept `known_revision` and return an `unchanged`
content type without opening file contents when metadata still matches. New text
previews check the revision again after reading to reject changes during the read.

All filesystem operations must remain inside the configured workspace root.
Bootstrap reads report missing allowlisted files separately, while inspection
or read failures remain explicit errors rather than being treated as absence.
Agent and Worker callers use the shared capability-checked write, delete, and
patch operations.
