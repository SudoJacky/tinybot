# Workspace Service
<!-- tinybot-module-fingerprint: sha256:5af9a8d6d54fc08b88e4b76b64e9a67f1a5b82fcd9c05671e5c911047cffbe11 -->

`workspace` provides capability-checked operations within the active workspace.
It handles safe path resolution, file reads and writes, directory inspection,
skill discovery, allowlisted bootstrap-file batch reads, and patch application.

All filesystem operations must remain inside the configured workspace root.
Bootstrap reads report missing allowlisted files separately, while inspection
or read failures remain explicit errors rather than being treated as absence.
Agent and Worker callers use the shared capability-checked write, delete, and
patch operations. The retired TinyOS-specific revision-guarded mutation wrapper
is no longer a separate workspace API.
