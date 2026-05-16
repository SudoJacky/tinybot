# Session Persistence

The session layer is the durable conversation boundary for normal chat. It stores message history, metadata, pending approvals, and runtime state that must survive process restarts.

## Ownership

| Concern | Module |
| --- | --- |
| Session data model | `tinybot/session/manager.py` |
| Session lifecycle | `tinybot/session/manager.py` |
| Agent-facing save helpers | `tinybot/agent/session_handler.py` |
| WebUI session routes | `tinybot/channels/websocket.py` |

## Design Intent

A session should be simple to load, safe to persist, and independent from a specific UI. CLI, WebUI, API, and channel adapters can all map user activity into session keys, but the stored conversation should not depend on any one caller.

The session manager is intentionally file-oriented. That keeps local workspaces portable and makes session state inspectable during debugging. Higher-level runtimes should avoid bypassing the manager because direct file edits can skip compatibility and cache behavior.

## Logical Flow

1. An entry point resolves a session key.
2. The manager returns an existing session or creates a new one.
3. The agent runtime appends user, assistant, tool, reasoning, and metadata messages.
4. The session handler saves after meaningful state changes.
5. WebUI and CLI read session lists and message history through the manager-facing APIs.

## Boundaries

- Session persistence owns conversation history, not domain-specific collaboration state. Cowork has its own session model.
- Session metadata can carry approval and UI state, but should not become a dumping ground for large derived artifacts.
- Message history should remain serializable and stable. Provider-specific transient objects should be normalized before storing.

## Compatibility Rules

- Add optional fields with defaults.
- Keep legacy load paths until old stores can be migrated safely.
- Prefer trimming or summarizing long history through explicit session methods instead of silent truncation at read time.
- Treat session keys as external identifiers; avoid changing key derivation without compatibility tests.

## Extension Points

- Add new message metadata only when another layer has a clear consumer.
- Add new list/filter fields through the manager so CLI and WebUI stay consistent.
- Add migration behavior at load boundaries, not in unrelated callers.

## Test Strategy

Use `tests/session/` for create/load/save/delete/list behavior. When agent runtime changes stored message shape, add session-handler or loop tests to prove the saved form can be reloaded.
