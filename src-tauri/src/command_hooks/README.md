# Command Hooks
<!-- tinybot-module-fingerprint: sha256:01596ba4be742274be9ea787e918667933f7bebcd868376d1c8eae57afb0b437 -->

`command_hooks` discovers, validates, reviews, and runs user-defined lifecycle
commands. Tinybot loads `hooks.json` from the global data directory and the
active workspace's `.tinybot` directory. Sources are additive.

The first supported Codex-compatible events are `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `PostCompact`. Each command receives one JSON
object on stdin and returns event-specific JSON on stdout. Only synchronous
`type: "command"` handlers are accepted.

Catalog snapshots provision a commented `hooks.example.jsonc` plus PowerShell
and POSIX shell skeletons under the global data directory. The example file is
never loaded, every response example is commented, and existing template files
are never overwritten. Their paths are returned to the desktop settings page
so users can copy only the examples they intend to activate.

Every handler is identified by a hash of its source path, event, matcher, and
complete command definition. Commands are skipped until that exact hash is
trusted in the global trust store. Editing a definition changes its hash and
requires another review. Hook processes inherit the desktop user's authority;
the Agent capability policy does not sandbox them.

The runner bounds stdin, stdout, and stderr, applies a timeout, and terminates
the process tree on timeout. Runtime events expose decisions and bounded
diagnostics without serializing command text or hook output.
