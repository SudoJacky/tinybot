# Context and Instructions
<!-- tinybot-doc-watch:
src-tauri/src/agent/bridge/thread_flow.rs
src-tauri/src/agent/runtime/README.md
src-tauri/src/agent/runtime/instructions.rs
src-tauri/src/agent/runtime/settings.rs
src-tauri/src/agent/runtime/usage.rs
src-tauri/src/config/application.rs
src-tauri/src/memory/README.md
src-tauri/src/runtime/working_directory.rs
src-tauri/src/system_prompt.rs
src-tauri/src/workspace/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:e5979bea90d92fdecf0370746a70fe855ecda8e0262c3247b3c912b81e550c3a -->

Tinybot composes model-visible instructions from explicit, traceable sources
before the Agent Runtime builds the bounded provider request. Instruction
composition and context-window management are separate stages.

## Workspace concepts

Tinybot uses two related paths:

- The backend workspace root comes from `agents.defaults.workspace`; when it is
  unset, the default is `~/.tinybot/workspace`.
- The effective Turn working directory comes from `cwd`, `workingDirectory`, or
  `working_directory` on the Turn or its metadata. A Thread's stored working
  directory is used when the Turn does not override it. The backend workspace
  root is the final fallback.

Relative working directories resolve under the backend workspace root.
Absolute working directories are allowed. The effective directory must already
exist and must be a directory.

## Instruction order

`InstructionComposer` renders instruction sources in increasing precedence:

1. Built-in Tinybot identity.
2. Turn-scoped developer instructions, when present.
3. `SYSTEM.md` from the backend workspace root, rendered with the effective
   working directory.
4. Optional `SOUL.md`, `USER.md`, and `TOOLS.md` from the backend workspace
   root.
5. Project instructions discovered from the effective working directory.
6. The Thread's fixed long-term-memory snapshot, explicitly marked as
   historical context rather than instructions.
7. Enabled Agent Plugin skill catalog and selected skill content.
8. Turn-scoped collaboration-mode and agent-role instructions.
9. Runtime environment facts, including the effective working directory and
   operating system.

The ordered sources are materialized as system instruction items. The runtime
records their identifiers, scope roots, hashes, truncation state, warnings,
and a hash of the complete rendered prompt.

## Global workspace profile and project instructions

`SOUL.md`, `USER.md`, `SYSTEM.md`, and `TOOLS.md` are global to the configured
backend workspace root. In particular, `USER.md` remains injected when a user
opens or assigns a different project working directory.

Project-specific rules use `AGENTS.md` or `AGENTS.override.md` in the effective
working-directory hierarchy. Tinybot finds the nearest ancestor containing a
`.git` marker, then loads at most one instruction file per directory from that
project root down to the working directory. `AGENTS.override.md` wins over
`AGENTS.md` within the same directory, and deeper files have higher
precedence.

This gives two distinct scopes:

```text
backend workspace root
    SYSTEM.md / SOUL.md / USER.md / TOOLS.md   (global profile)

effective project working directory
    project root/AGENTS.md
    ...
    working directory/AGENTS.override.md       (project hierarchy)
```

## Context construction

After instruction composition, the runtime combines:

- composed system instruction items;
- restored Thread or continuation history;
- the fixed long-term-memory snapshot already represented in instructions;
- bounded evidence from registered context contributors;
- the current user input and tool continuation state.

Context contributors add evidence after composed instructions. They do not
receive instruction precedence and must emit bounded provenance rather than
unbounded prompt text in diagnostics.

The runtime estimates the provider request against the effective context
window. When no strategy is configured, the strategy is `compact`. Compaction
summarizes older context through the provider, persists a context checkpoint,
and retains recent messages. Explicit `discard` remains available and keeps the
newest messages that fit without creating a summary.

Exact configuration names and defaults belong in the
[desktop command reference](../api/desktop.md#config-commands).

## Failure behavior

- A configured working directory that does not exist is an error.
- Invalid or oversized workspace instruction files fail composition instead of
  being silently ignored.
- Missing optional workspace profile files are allowed; other inspection and
  read failures remain visible.
- Project instructions share a bounded byte budget and record truncation and
  invalid UTF-8 warnings in provenance.
- Compaction failure is explicit and does not silently fall back to discard.

## Source modules and verification

- [Agent bridge](../../src-tauri/src/agent/bridge/README.md)
- [Agent runtime](../../src-tauri/src/agent/runtime/README.md)
- [Workspace module](../../src-tauri/src/workspace/README.md)
- `src-tauri/src/agent/runtime/instructions.rs`
- `src-tauri/src/agent/runtime/instructions_tests.rs`
- `src-tauri/src/runtime/working_directory.rs`
