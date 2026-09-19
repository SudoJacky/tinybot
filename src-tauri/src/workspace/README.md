# Workspace Service
<!-- tinybot-module-fingerprint: sha256:90b2dab14af87b72324dd4500119ee2a6365d499a4998d8bf33d3918e05f3a1d -->

`workspace` provides capability-checked operations within the active workspace.
It handles safe path resolution, file reads and writes, directory inspection,
skill discovery, allowlisted bootstrap-file batch reads, and patch application.

`search_file_content` runs the pinned, bundled ripgrep executable directly with
`FsWorkspaceRead`; it never resolves PATH or invokes a shell. Search paths are
relative to the active workspace and must resolve inside it. Directory walks
do not follow symlinks or junctions and exclude `.git`. The default respects
project ignore rules and skips hidden/binary files; explicit file paths and
glob inclusions follow ripgrep's documented overrides. Parent project ignore
files still apply when searching a subdirectory. Host ripgrep configuration,
global Git ignore files, and ambient secrets do not influence execution.

Search results contain matching/context lines, relative paths, and one-based
line numbers. Matching-line and serialized-entry byte limits stop the child
and mark results incomplete. Bounded JSON records and a bounded producer queue
keep large lines from growing output memory without limit. Cancellation and the
30-second deadline terminate and reap the process before returning an error;
both pipes are drained/joined. Exit 1 is a valid no-match result; stderr, other
exit failures, unsupported text encoding, and missing bundled executables are
explicit errors. Diagnostics record duration, counts, stop reason and failure
category without logging queries or matched content. Real-binary tests live in
`search/tests.rs`; run `npm run prepare:ripgrep` before direct Cargo tests.

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
