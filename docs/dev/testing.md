# Testing and Validation

Tinybot uses `uv` for dependency management and command execution. CI installs the development extras and runs pytest, Ruff over tests, and MyPy over `tinybot`.

## Local Commands

Use these commands from the repository root:

```bash
uv sync --extra dev
uv run pytest
uv run ruff check tests/
uv run ruff format --check tests/
uv run mypy tinybot --ignore-missing-imports
```

For focused Cowork work, prepare and ask the user to run:

```bash
uv run pytest tests/cowork
```

For frontend-only syntax checks:

```bash
node --check webui/assets/src/legacy/app.js
```

For lightweight Python syntax validation when full test dependencies are blocked:

```bash
uv run python -m compileall tinybot/cowork tinybot/agent/tools/cowork.py tinybot/api/cowork.py
```

## Test Ownership

| Area | Test Location | What To Prove |
| --- | --- | --- |
| Agent runtime | `tests/agent/` | Context building, loop behavior, tool execution, streaming, memory and experience flow |
| Task planning | `tests/task/` | Plan creation and execution strategy |
| Cowork | `tests/cowork/` | Session lifecycle, mailbox, policies, blueprint, swarm, API, observability |
| Knowledge | `tests/agent/test_knowledge_*.py` | Retrieval, preprocessing, parent-child chunks, rerank, semantic behavior |
| Config | `tests/test_config*.py` | Schema defaults, validation, loading behavior |
| Providers | `tests/providers/` | Provider registry and provider response handling |
| Security | `tests/security/` | Network, shell, crypto, audit, approval behavior |
| WebSocket/channels | `tests/channels/` | Channel behavior and gateway-adjacent contracts |

## CI Contract

`.github/workflows/ci.yml` currently runs three jobs:

- `test`: `uv run pytest --cov=tinybot --cov-report=xml --cov-report=term-missing`
- `lint`: `uv run ruff check tests/` and `uv run ruff format --check tests/`
- `typecheck`: `uv run mypy tinybot --ignore-missing-imports`

Ruff is currently scoped to tests in CI, while MyPy checks the package with a permissive configuration. Do not assume CI catches frontend syntax or generated docs regressions.

## Practical Validation Rules

- For service changes, run or request the focused service test module.
- For API snapshot changes, add or update API tests before changing WebUI expectations.
- For WebUI changes, run `node --check` at minimum and manually inspect the route when layout or interaction changed.
- For persistence changes, add load tests that omit the new field to prove older stores hydrate safely.
- For Cowork scheduling or completion changes, test both active progress and blocked/no-progress paths.
