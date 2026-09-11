# Tools
<!-- tinybot-module-fingerprint: sha256:8384fa58debdfdd6d13dd0aca2e45108602bbe8ff70883fec5cf1afa1f5d197c -->

`tools` contains the backend tool system used by agent turns.

It combines tool execution, capability decisions, registry metadata, shell
processes, and web tools. Individual tool implementations remain in their
focused submodules.

`action_fusion.rs` composes one workspace patch with one explicitly supplied
non-interactive Shell command through `apply_patch.thenRun`. It requires the
default-off `experiments.actionFusion` flag and Exec access. Shell preflight
runs before editing; patch failure skips the command. After a successful patch,
the command's working directory is resolved so it may be created by that patch;
if it is still invalid, the result retains the patch and a command-start error.
Command failure retains the edit and both stage results. Running commands reuse
the retained-process continuation contract instead of reapplying the patch.
This is one exclusive Agent tool operation, not a filesystem lock or a transaction
that rolls back edits when verification fails. Request/trace logs and
`actionFusion.*` counters expose stage outcomes for experiment evaluation.
