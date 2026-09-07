# Workspace Service
<!-- tinybot-module-fingerprint: sha256:c37e701305b5abdec75a1aa438f2113f0e0db750d25c41a98082506e4e0da2c4 -->

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

`artifact_review` owns a persisted baseline per canonical workspace, Thread and
file. Explicit references save up to 25 MiB before dispatch; pending requests
reuse the baseline until accepted or restored. Snapshots live below the native
application data root, outside the workspace, and are verified by SHA-256.
Accept checks the compared content hash; restore checks it again immediately
before atomic replacement and preserves the original file bytes. A malformed
manifest, corrupt snapshot or changed source is an explicit error.
