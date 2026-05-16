# Tinybot Developer Documentation

This directory records Tinybot's internal design. It is for maintainers and agents changing the codebase, not for end-user setup or feature guides.

The documents should explain intent, boundaries, data flow, contracts, extension points, and verification strategy. Avoid copying large code blocks. Link to source files and tests instead.

## Reading Order

1. [Architecture](architecture.md): the system-level shape and runtime boundaries.
2. [API Design](api.md): HTTP surfaces, snapshot contracts, and route ownership.
3. [Testing and Validation](testing.md): local checks, CI expectations, and test layout.
4. Module notes:
   - [Agent Runtime](modules/agent.md)
   - [Cowork Runtime](modules/cowork.md)
   - [Knowledge and RAG](modules/knowledge.md)
   - [Configuration](modules/config.md)
   - [Session Persistence](modules/session.md)
   - [Task Planning](modules/task.md)
   - [Providers](modules/providers.md)
   - [Channels and Message Bus](modules/channels.md)
   - [Security](modules/security.md)
   - [Cron, Heartbeat, and Events](modules/automation.md)
   - [CLI and Commands](modules/cli.md)
   - [WebUI](modules/webui.md)

## Documentation Conventions

- Prefer design-level language over function-by-function walkthroughs.
- Keep source references precise: name the module or test file that owns the behavior.
- When a module has both user-facing docs and internal notes, put user behavior in `docs/` and maintainer reasoning in `docs/dev/`.
- If a change is being developed through OpenSpec, keep proposal/spec/task state in `openspec/`, then copy durable architectural decisions here after the design settles.
- Keep examples small and schema-shaped. Do not paste long implementation snippets.

## Current Source Map

| Area | Primary Code | Tests | User Docs |
| --- | --- | --- | --- |
| Agent runtime | `tinybot/agent/` | `tests/agent/` | `docs/tasks.md`, `docs/tools.md`, `docs/skills.md` |
| Cowork runtime | `tinybot/cowork/`, `tinybot/agent/tools/cowork.py` | `tests/cowork/` | `docs/cowork.md` |
| API and gateway | `tinybot/api/`, `tinybot/channels/websocket.py` | `tests/cowork/test_api.py`, API-adjacent tests | `docs/gateway.md` |
| Knowledge/RAG | `tinybot/agent/knowledge.py`, `tinybot/api/knowledge.py`, `tinybot/agent/tools/knowledge.py` | `tests/agent/test_knowledge_*.py` | `docs/knowledge.md` |
| Config/providers | `tinybot/config/`, `tinybot/providers/` | `tests/test_config*.py`, `tests/providers/` | `docs/config.md`, `docs/providers.md` |
| Sessions | `tinybot/session/` | `tests/session/` | `docs/tasks.md` |
| Task planning | `tinybot/task/` | `tests/task/` | `docs/tasks.md` |
| Channels and bus | `tinybot/channels/`, `tinybot/bus/`, `tinybot/command/` | `tests/channels/`, `tests/bus/` | `docs/gateway.md` |
| Security | `tinybot/security/` | `tests/security/` | `docs/config.md` |
| Cron and heartbeat | `tinybot/cron/`, `tinybot/heartbeat/` | targeted service tests when present | `docs/gateway.md` |
| WebUI | `webui/` | syntax checks and API tests | `docs/webui.md` |
