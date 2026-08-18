# Skills
<!-- tinybot-module-fingerprint: sha256:c335c8bb88f77bc9c323dbc987e4e7275cc3b34c5c18feb57e17ad53128f75f0 -->

`skills` parses, renders, and resolves legacy workspace skill documents for the
Workspace and Skills APIs. Native agent turns select skills from enabled global
Agent Plugins instead of this legacy workspace resolver.

- `definition.rs` owns the `SKILL.md` format.
- `resolver.rs` selects and orders applicable skills.
