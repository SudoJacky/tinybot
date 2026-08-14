# Workspace Service
<!-- tinybot-module-fingerprint: sha256:a4896a3466636fea1d9d162391ceb6d4da7bdeacbd10a76737ad10b74480e094 -->

`workspace` provides capability-checked operations within the active workspace.
It handles safe path resolution, file reads and writes, directory inspection,
skill discovery, allowlisted bootstrap-file batch reads, and patch application.

All filesystem operations must remain inside the configured workspace root.
Bootstrap reads report missing allowlisted files separately, while inspection
or read failures remain explicit errors rather than being treated as absence.
