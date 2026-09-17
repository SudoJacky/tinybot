# Workspace Patches
<!-- tinybot-module-fingerprint: sha256:103b9ca17e1603c18ab3a04e1829ff6737416bdecd238154bbceffa604ce424d -->

`patch` parses and applies Codex-compatible file patches. It supports adding,
updating, moving, and deleting files while validating paths and matching all
changes before mutating the workspace.

Parsing, matching, filesystem access, and the apply engine are kept separate
to make failure behavior explicit and testable.

Parse failures report `stage: "parse"`, a one-based line in the submitted patch,
the offending content, and the file path when known. Content and path excerpts
are capped at 256 and 512 UTF-8 bytes, with explicit truncation flags. A repair
hint explains missing Add File prefixes, including empty lines. The workspace
boundary reports an exact empty `committed` summary for parse failures; execution
failures continue to report any changes already committed. Diagnostics never
repair or retry malformed patches automatically.
