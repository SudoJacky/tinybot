# Configuration

Configuration is the shared contract between CLI, gateway, providers, security settings, knowledge behavior, and user preferences. The design goal is strict schema validation with convenient load/save helpers.

## Ownership

| Concern | Module |
| --- | --- |
| Schema | `tinybot/config/schema.py` |
| Load/save | `tinybot/config/loader.py` |
| Path resolution | `tinybot/config/paths.py` |
| CLI configuration flow | `tinybot/cli/onboard.py`, `tinybot/cli/config_editor.py` |
| WebUI configuration API | `tinybot/channels/websocket.py` |
| Provider implementations | `tinybot/providers/` |

## Design Rules

- Schema defaults belong in `schema.py`.
- File discovery and persistence belong in `loader.py` and `paths.py`.
- UI and CLI flows should use the loader rather than manually editing config files.
- Provider-specific fields should be represented in the provider config model rather than stored as untyped side data.
- Secrets should prefer environment variable references when the UI supports it.

## Provider Profiles

Providers are selected through config and resolved through `tinybot/providers/registry.py`. Provider implementations should follow the `LLMProvider` contract in `tinybot/providers/base.py`.

When adding a provider:

- Add schema support if new config fields are needed.
- Register provider metadata.
- Implement chat and streaming behavior consistently with existing provider result types.
- Add provider tests for registry behavior and response handling.

## Compatibility

Config changes should be backward compatible where possible. If a new field is optional, provide a schema default. If a field must be renamed, support old input at the load boundary until migration is explicit.

## Test Strategy

Use `tests/test_config.py`, `tests/test_config_validation.py`, and `tests/providers/`. Tests should cover defaults, invalid values, environment-variable references, provider selection, and save/load round trips.
