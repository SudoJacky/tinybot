# CLI and Commands

The CLI is both a user entry point and a maintainer control surface. It should compose runtime services rather than owning their internal behavior.

## Ownership

| Concern | Module |
| --- | --- |
| Typer command tree | `tinybot/cli/commands.py` |
| Onboarding flow | `tinybot/cli/onboard.py` |
| Config editor | `tinybot/cli/config_editor.py` |
| Streaming terminal helpers | `tinybot/cli/stream.py` |
| Built-in chat commands | `tinybot/command/` |

## Design Intent

CLI commands should do four things:

1. Load runtime config.
2. Construct the needed service or runtime.
3. Translate CLI options into service calls.
4. Render human-readable output.

Long-running services such as gateway, API server, cron, heartbeat, and channel manager are started here, but their logic should remain in their own modules.

## Main Command Groups

| Group | Purpose |
| --- | --- |
| `agent` | Interactive or one-shot chat execution |
| `gateway` | WebUI, channels, cron, heartbeat, and API route hosting |
| `api` | OpenAI-compatible API server |
| `cowork` | Standalone Cowork control plane |
| `channels` | Channel status and login flows |
| `plugins/provider login/status` | Operational setup and inspection |
| `onboard` | Initial configuration |

## Rendering Rules

The CLI can format progress, markdown, reasoning, and task snapshots for humans. That formatting should not alter stored session state. When a field is needed by both CLI and WebUI, expose it from the service or session snapshot instead of recomputing it twice.

## Boundaries

- CLI should not mutate service internals directly.
- CLI-specific terminal behavior should stay in CLI helpers.
- Config loading and migration helpers can live near CLI startup, but reusable config rules belong in `tinybot/config/`.
- Cowork CLI commands should use the same service/API concepts as the WebUI path.

## Extension Checklist

- Add command options that map cleanly to service parameters.
- Validate user input at the command boundary.
- Keep output concise and script-friendly where possible.
- Add docs in user-facing `docs/` if the command is public.
- Add developer notes here only when the command affects architecture or runtime wiring.

## Test Strategy

CLI behavior is often covered indirectly through service tests. For command-specific behavior, add focused tests around option parsing, config loading, output shape, and service invocation boundaries.
