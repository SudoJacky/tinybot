# Cowork Runtime

Cowork is Tinybot's persistent multi-agent collaboration runtime. It is designed as a service-owned state machine with multiple control planes: agent tool, standalone CLI, HTTP API, and WebUI.

User-facing behavior is documented in `docs/cowork.md`. This file explains the maintainer model.

## Ownership

| Concern | Module |
| --- | --- |
| Persistent session service and state transitions | `tinybot/cowork/service.py` |
| Dataclasses and persisted schema | `tinybot/cowork/types.py` |
| Architecture names and aliases | `tinybot/cowork/architecture.py` |
| Runtime policies | `tinybot/cowork/policies/` |
| Mailbox protocol | `tinybot/cowork/mailbox.py` |
| Blueprint validation/preview/export | `tinybot/cowork/blueprint.py` |
| Swarm planning and queues | `tinybot/cowork/swarm.py` |
| Graph, trace, and artifact projections | `tinybot/cowork/snapshot.py`, `tinybot/cowork/trace.py` |
| Agent-facing tools | `tinybot/agent/tools/cowork.py` |
| HTTP API | `tinybot/api/cowork.py` |

## Core Model

A `CoworkSession` contains agents, tasks, messages, threads, mailbox records, branches, graph/trace state, budgets, shared memory, and completion metadata. `CoworkService` is the owner of this model. Other layers should call service methods and consume snapshots rather than mutating session internals.

The service keeps compatibility by hydrating missing fields with defaults. This is important because stored sessions can outlive the code version that created them.

## Architecture Policies

Architecture-specific behavior belongs in `tinybot/cowork/policies/`. A policy can define:

- Topology and branch initialization.
- Step selection and scheduling semantics.
- Envelope routing behavior.
- Delegation handling.
- Completion evaluation.
- Organization projections for the UI/API.

Shared lifecycle, persistence, budget accounting, branch result selection, and generic observability should remain in `CoworkService`.

## Scheduling and Completion

The scheduler ranks agents by readiness signals: inbox pressure, reply-required mailbox records, assigned ready tasks, claimable shared tasks, blocked state, repeated activation, and lead synthesis pressure.

Completion is not just "all tasks completed." `completion_decision` captures the next action, blockers, review failures, fanout state, disagreements, readiness scores, and finalization state. `final_draft` is a synthesized current output, while branch results and session final results model explicit final selection.

## Structured Results

Agents can complete tasks with structured results containing answer, findings, risks, open questions, artifacts, and confidence. The service extracts this into:

- `task.result_data`
- `task.confidence`
- shared memory buckets
- shared summary
- artifact index
- `final_draft`
- completion and blocker assessment

This structure is the main intelligence path. Prefer extending structured result contracts over adding fragile prose conventions.

## API and UI Contract

`tinybot/api/cowork.py` exposes snapshots with session state, branch state, graph/trace projections, run metrics, scheduler decisions, artifacts, work queues, `completion_decision`, and `final_draft`.

The WebUI expects these fields to be stable enough for rendering. When changing snapshot shape, update API tests and frontend consumers together.

## Extension Checklist

- Add or update dataclass fields in `types.py`.
- Hydrate missing persisted fields in `CoworkService._load`.
- Persist fields in the save path.
- Add service tests for state transitions.
- Add API tests if snapshots or routes change.
- Add WebUI rendering only after the API shape is stable.
- Update `docs/cowork.md` for user-facing behavior and this document for maintainer rules.

## Test Strategy

Use `tests/cowork/`:

- `test_service.py` for session state and completion logic.
- `test_mailbox.py` for envelope routing and lifecycle.
- `test_policies.py` for architecture policy behavior.
- `test_swarm.py` for swarm work-unit scheduling and reducer/reviewer flow.
- `test_blueprint.py` for reusable topology.
- `test_api.py` for HTTP snapshot and control contracts.
- `test_observability.py` for graph, trace, and detail projections.
