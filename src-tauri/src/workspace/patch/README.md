# Workspace Patches
<!-- tinybot-module-fingerprint: sha256:1e1a361465435eb891f9c193fe5ddeb3454da57fc9c97035c82a13958fe2f587 -->

`patch` parses and applies Codex-compatible file patches. It supports adding,
updating, moving, and deleting files while validating paths and matching all
changes before mutating the workspace.

Parsing, matching, filesystem access, and the apply engine are kept separate
to make failure behavior explicit and testable.
