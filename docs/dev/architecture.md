# Architecture

Tinybot is a local-first agent application with several entry points over one set of runtime services. The core design choice is to keep durable state and orchestration in Python services, while UI, CLI, and API layers act as control planes over those services.

## Runtime Layers

| Layer | Responsibility | Main Modules |
| --- | --- | --- |
| Entry points | CLI commands, gateway server, OpenAI-compatible API, channel adapters | `tinybot/cli/`, `tinybot/api/`, `tinybot/channels/` |
| Agent execution | Prompt assembly, provider calls, tool execution, streaming, session persistence | `tinybot/agent/`, `tinybot/session/` |
| Collaboration runtimes | Cowork sessions, task orchestration, mailbox, branches, graph and trace projections | `tinybot/cowork/`, `tinybot/agent/tools/cowork.py` |
| Knowledge services | Document ingestion, retrieval, semantic extraction, GraphRAG projections | `tinybot/agent/knowledge.py`, `tinybot/api/knowledge.py` |
| Infrastructure | Configuration, providers, security, task planning, cron/heartbeat, bus events | `tinybot/config/`, `tinybot/providers/`, `tinybot/security/`, `tinybot/task/`, `tinybot/cron/`, `tinybot/heartbeat/`, `tinybot/bus/` |
| Presentation | Browser UI, docs HTML, static assets | `webui/`, `docs/`, `scripts/build_docs.py` |

## Data Flow

The normal chat path starts from a CLI, API, or channel request. The request is normalized into an agent session, the agent runtime builds context, the provider produces either text or tool calls, and tool calls are executed through the registry. Session updates are persisted by the session layer and streamed back to the caller where the entry point supports streaming.

Cowork is a parallel orchestration path. It can be reached as a user tool, through its standalone CLI command group, or through gateway APIs. Cowork stores its own session model under the workspace, schedules agents through architecture policies, and exposes snapshots for WebUI and API consumers.

Knowledge is a support service. It can be called as an agent tool, queried directly through HTTP routes, or used automatically by session context logic. The knowledge layer owns retrieval and graph signals; the agent runtime decides when and how retrieved context is injected.

## Persistence Boundaries

- Chat sessions are owned by `tinybot/session/`.
- Cowork session state is owned by `CoworkService` in `tinybot/cowork/service.py`.
- Knowledge indexes and metadata are owned by the knowledge store implementation in `tinybot/agent/knowledge.py`.
- Configuration is loaded and saved through `tinybot/config/loader.py`; callers should not hand-edit config file paths directly unless they are a config UI or migration.

Keep these boundaries stable. UI code and API handlers should request snapshots or call service methods instead of mutating persisted structures directly.

## Extension Principles

- Add capabilities at the service layer first, then expose them through API/CLI/WebUI as needed.
- Prefer explicit data contracts over implicit string parsing. Cowork task results and knowledge query payloads are examples of structured contracts.
- Keep compatibility at load boundaries. Older persisted sessions should hydrate with defaults rather than failing because a new field was added.
- Add tests at the owner boundary: service tests for state transitions, API tests for snapshot contracts, and UI syntax checks for frontend changes.

## Design Records

OpenSpec artifacts live under `openspec/`. They are useful for active or recently completed design work, especially large Cowork changes. Durable module-level decisions should be consolidated into this directory after the implementation settles.
