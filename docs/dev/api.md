# API Design

Tinybot exposes two HTTP surfaces:

- The OpenAI-compatible API in `tinybot/api/server.py`.
- The gateway/WebUI API in `tinybot/channels/websocket.py`, with dedicated route modules such as `tinybot/api/knowledge.py` and `tinybot/api/cowork.py`.

The design goal is to keep handlers thin. Handlers should validate request shape, call the owning service, and return a stable snapshot. Business rules should stay in service modules.

## OpenAI-Compatible API

`tinybot/api/server.py` provides:

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | Chat-completion compatible entry point |
| `GET /v1/models` | Provider/model listing |
| `GET /health` | Basic process health |

This surface should remain conservative. It is an interoperability boundary, so avoid adding Tinybot-specific behavior that would surprise OpenAI-compatible clients.

## Gateway API

`tinybot/channels/websocket.py` owns the hosted WebUI gateway. It registers:

- Web bootstrap and WebSocket routes.
- Session list/message/profile routes.
- Config, provider, status, tools, approvals, skills, and workspace file routes.
- A gateway-level Cowork proxy surface.
- Static assets and generated documentation pages.

Gateway handlers are allowed to be WebUI-shaped. Their response payloads can include presentation-oriented metadata when that reduces frontend coupling, but they should still avoid duplicating service logic.

## Knowledge API

`tinybot/api/knowledge.py` registers the `/v1/knowledge/*` routes:

| Group | Routes | Owner Contract |
| --- | --- | --- |
| Documents | list, add, upload, get, delete | Document metadata and content lifecycle |
| Query | `POST /v1/knowledge/query` | Retrieval mode, rerank, and result payloads |
| Stats | `GET /v1/knowledge/stats` | Index readiness and counts |
| Graph | `GET /v1/knowledge/graph`, `GET /v1/knowledge/graphrag` | Entity/relation/community projections |
| Jobs | job status, rebuild index | Long-running indexing visibility |

Knowledge responses should be explainable: include source document, retrieval method, confidence or score where available, and enough metadata for the WebUI to explain why an item matched.

## Cowork API

`tinybot/api/cowork.py` registers the dedicated `/api/cowork/*` routes. This is the most stateful API surface in the project.

| Group | Routes | Design Intent |
| --- | --- | --- |
| Blueprints | validate, preview | Validate reusable collaboration topology before persistence |
| Sessions | list, create, get, delete, summary | Stable session control and snapshot retrieval |
| Execution | run, pause, resume, emergency-stop | Explicit control over scheduling and budget use |
| Graph/trace | graph, trace, observations, DAG, artifacts, queues | Observable runtime projections for WebUI and debugging |
| Branches | list, select, derive, result select, result merge | Compare and finalize alternative collaboration continuations |
| Tasks/work units | add, assign, retry, review, skip, cancel | Human steering over task and swarm execution |
| Budget | update budget | Keep autonomy bounded and inspectable |

Cowork snapshots intentionally expose derived fields such as `completion_decision`, `final_draft`, `artifact_index`, `scheduler_decisions`, and `run_metrics`. These are API contracts for the UI and should be tested when changed.

## Handler Guidelines

- Return JSON objects with explicit keys; avoid bare arrays at route boundaries unless an existing route already does so.
- Keep route-specific error messages actionable and stable enough for UI display.
- For new mutable routes, add service tests for the state transition and API tests for request/response shape.
- For long-running or background work, expose job or run status rather than blocking indefinitely.
- Preserve old fields when adding richer replacements. Add new fields first, then remove legacy fields only through a deliberate migration.
