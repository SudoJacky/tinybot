# Workspace Patches

`patch` parses and applies Codex-compatible file patches. It supports adding,
updating, moving, and deleting files while validating paths and matching all
changes before mutating the workspace.

Parsing, matching, filesystem access, and the apply engine are kept separate
to make failure behavior explicit and testable.
