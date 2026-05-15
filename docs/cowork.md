# Cowork

Cowork is a persistent multi-agent workspace for goals that benefit from several specialized perspectives. It is not limited to software roles: Tinybot can create a team for research, travel planning, writing, analysis, operations, or other broad tasks.

## What It Adds

- Dynamic team planning from the user goal
- One persistent context per agent
- Agent inboxes and discussion threads
- A shared task list with optional ownership, lead assignment, and teammate self-claim
- Session events for status and UI updates
- Agent-to-agent messages through the internal cowork tool
- Readiness scoring for smarter scheduling
- Structured task results, shared memory, blocker snapshots, and final drafts
- Architecture runtime policies for Adaptive Starter, Agent Team, Generator-Verifier, Message Bus, Shared State, and Swarm
- Cowork branches for architecture derivation, branch-local continuation, branch results, and explicit session final-result selection or merge
- Agent Steps with default summaries, tool observations, browser observations, full-detail expansion, and sensitivity/redaction states
- Versioned graph and trace projections for agents, tasks, mailbox envelopes, artifacts, memory, decisions, budgets, and scheduler causality
- Architecture-specific organization projections inside one shared Cowork UI shell
- Reusable Cowork blueprints for graph-oriented team setup, validation, preview, launch, and export
- Session budgets for rounds, parallel width, agent calls, spawned agents, tool calls, tokens, cost hints, and explicit stop reasons

## Runtime Model

Cowork follows a shared-session runtime model:

1. Cowork Session: one persistent collaboration container shared by every architecture.
2. Architecture Runtime Policy: the architecture-specific owner of topology, scheduling, routing, delegation, completion, and projection semantics.
3. Cowork Branch: an independent continuation inside the same session, optionally derived from a source branch with an organized Stage Record.
4. Control plane: the API, CLI, and WebUI consume the same session snapshot, branches, graph, trace, budget, blueprint, Agent Steps, and blocker contracts.

## Basic Use

Start a session:

```text
Use cowork to plan a seven-day family trip to Japan, balancing budget, food, logistics, and kid-friendly activities.
```

Tinybot can call:

```text
cowork action=start goal="..." auto_run=true
```

Check status:

```text
cowork action=status session_id="cw_xxxxxxxx" verbose=true
```

Run more rounds:

```text
cowork action=run session_id="cw_xxxxxxxx" max_rounds=3 max_agents=4
```

## Standalone CLI

Cowork also has its own command group, so it can be used without entering the normal chat loop:

```bash
uv run tinybot cowork start "Plan a seven-day family trip to Japan" --run --rounds 2
uv run tinybot cowork start "Compare release plans" --architecture generator_verifier --run
uv run tinybot cowork list
uv run tinybot cowork status cw_xxxxxxxx --verbose
uv run tinybot cowork run cw_xxxxxxxx --rounds 3
uv run tinybot cowork message cw_xxxxxxxx "Prioritize train travel" --to researcher
uv run tinybot cowork task cw_xxxxxxxx "Check rainy-day options" --agent analyst
uv run tinybot cowork task cw_xxxxxxxx "Find backup restaurant options"
uv run tinybot cowork summary cw_xxxxxxxx
```

This path constructs a standalone Cowork runtime instead of a full chat `AgentLoop`.

Use `--architecture` for new CLI commands. The older `--mode` option is accepted as a compatibility alias, and legacy `hybrid` input normalizes to `adaptive_starter`.

Blueprint commands:

```bash
uv run tinybot cowork validate-blueprint cowork-plan.json
uv run tinybot cowork preview-blueprint cowork-plan.json
uv run tinybot cowork launch-blueprint cowork-plan.json --run --until-idle --agents 8 --agent-calls 80
uv run tinybot cowork export-blueprint cw_xxxxxxxx
```

Existing commands keep their behavior. New budget flags are optional:

```bash
uv run tinybot cowork run cw_xxxxxxxx --rounds 10 --agents 6 --agent-calls 60 --until-idle
```

## Blueprint Example

```json
{
  "goal": "Prepare a release readiness review",
  "workflow_mode": "swarm",
  "agents": [
    {
      "id": "lead",
      "name": "Lead",
      "role": "Coordinator",
      "goal": "Keep the review moving",
      "tools": ["cowork_internal"],
      "subscriptions": ["coordination", "summary"]
    },
    {
      "id": "qa",
      "name": "QA",
      "role": "Verifier",
      "goal": "Check risks and test gaps",
      "tools": ["read_file", "list_dir", "cowork_internal"],
      "subscriptions": ["review", "risk"]
    }
  ],
  "tasks": [
    {
      "id": "collect",
      "title": "Collect release facts",
      "description": "Summarize scope, changes, and open risks.",
      "assigned_agent_id": "lead"
    },
    {
      "id": "verify",
      "title": "Verify readiness",
      "description": "Review the collected facts.",
      "assigned_agent_id": "qa",
      "dependencies": ["collect"],
      "review_required": true,
      "reviewer_agent_ids": ["qa"]
    }
  ],
  "routes": [
    {"id": "lead_to_qa", "from": "lead", "to": "qa", "kind": "handoff", "topic": "review"}
  ],
  "budgets": {
    "parallel_width": 4,
    "max_rounds_per_run": 20,
    "max_agent_calls_per_run": 60,
    "max_spawned_agents": 2
  },
  "layout": {
    "nodes": {
      "lead": {"x": 220, "y": 180},
      "qa": {"x": 520, "y": 180}
    }
  }
}
```

Validation returns diagnostics with `severity`, `code`, `message`, and `path`. Duplicate ids, missing references, dependency cycles, invalid routes, unknown reviewers, disallowed tools, and out-of-policy budgets are reported before any session is created. Preview returns the normalized blueprint, graph preview, budget plan, and initial ready work without writing to the Cowork store.

## WebUI and Gateway

When Tinybot is started with `tinybot gateway`, the hosted WebUI includes an independent Cowork entry in the right panel. The same workspace can also be opened directly at:

```text
http://127.0.0.1:<gateway-port>/cowork
```

The frontend calls the gateway Cowork API under `/api/cowork`, while normal chat, skills, knowledge, and workspace editing continue to use their existing routes.

Blueprint and control endpoints:

```text
POST /api/cowork/blueprints/validate
POST /api/cowork/blueprints/preview
POST /api/cowork/sessions              # accepts either goal or blueprint
GET  /api/cowork/sessions/{id}
GET  /api/cowork/sessions/{id}/graph
GET  /api/cowork/sessions/{id}/trace
GET  /api/cowork/sessions/{id}/blueprint
POST /api/cowork/sessions/{id}/run     # accepts max_rounds, max_agents, max_agent_calls, run_until_idle, stop_on_blocker
GET  /api/cowork/sessions/{id}/branches
POST /api/cowork/sessions/{id}/branches/{branch_id}/select
POST /api/cowork/sessions/{id}/branches/{branch_id}/derive
POST /api/cowork/sessions/{id}/branches/{branch_id}/result/select-final
POST /api/cowork/sessions/{id}/branch-results/merge
GET  /api/cowork/sessions/{id}/observations/{detail_id}
```

Send a message to agents:

```text
cowork action=send_message session_id="cw_xxxxxxxx" recipient_ids=["researcher"] content="Prioritize train travel."
```

Add an unassigned task to the shared pool:

```text
cowork action=add_task session_id="cw_xxxxxxxx" title="Compare museum passes"
```

Assign an existing task explicitly:

```text
cowork action=assign_task session_id="cw_xxxxxxxx" task_id="task_xxxxxxxx" assigned_agent_id="analyst"
```

## How Context Works

Each agent keeps its own private summary and inbox. Shared information moves through tasks, discussion threads, and completed task results. This keeps token use bounded because agents do not receive every other agent's full history on every round.

## Agent Team Workflow

Cowork follows the same basic shape as an agent team:

- A lead or user creates the session, agents, and initial task list.
- Starting a session sends the user goal only to the lead and creates only a lead-owned delegation task.
- Tasks can be assigned to a specific agent or left unassigned in the shared task pool.
- Non-lead agents start idle and should be activated by lead messages or lead-assigned tasks.
- When an agent has no assigned ready task, it can claim the lowest-id unassigned task whose dependencies are complete.
- Agents coordinate through mailbox records, direct messages, and discussion threads instead of sharing full private context.
- The scheduler wakes agents with inbox work, assigned ready tasks, claimable shared tasks, or unanswered mailbox requests.
- The scheduler ranks candidates by readiness, including reply pressure, ready tasks, shared tasks, blocked status, repeated activation, and whether the lead needs to synthesize.
- The user talks only to the lead. User broadcasts and direct messages to non-lead agents are routed to the lead.
- Non-lead agents cannot talk directly to the user. Their user-facing notes are routed to the lead for review and synthesis.
- The user can still monitor all mailbox messages, events, tasks, and agent status through the Cowork UI/API.
- When an agent answers another agent's reply-required request, the answer is routed back to the requester and marks the mailbox record as replied.

## Architectures

Cowork uses one persistent session model with architecture runtime policies instead of separate systems. New sessions, blueprints, API responses, CLI output, and WebUI labels use canonical architecture names.

- `adaptive_starter`: clarifies vague goals, recommends a concrete architecture, or starts the smallest useful collaboration structure.
- `team`: long-running specialist agents keep private summaries, own worker domains, coordinate through tasks/messages, and synthesize through a coordinator.
- `generator_verifier`: producers create candidate answers or artifacts, then verifiers check them against an explicit rubric and produce pass, revision, or blocker verdicts.
- `message_bus`: mailbox records act as routed envelopes with topics, event types, lineage, subscribers, direct routes, and reply correlation.
- `shared_state`: agents directly accumulate findings, evidence, competing claims, risks, open questions, decisions, and artifacts in shared memory.
- `swarm`: dynamic sub-agent creation, parallel work units, queue-aware fanout, synthesis, review gates, and budget-aware horizontal scaling.

Legacy stored `hybrid` values and legacy CLI/API inputs still load and normalize to `adaptive_starter`. `supervisor`, `orchestrator`, and `peer_handoff` are compatibility-era names, not current creation choices.

The scheduler also tracks convergence. If consecutive rounds produce no new tracked messages, tasks, completed results, artifacts, or shared-memory entries, the session reports `review_convergence` instead of spending more rounds.

## Budget Semantics

Every session exposes:

- `budget_state.limits`: configured caps such as `parallel_width`, `max_rounds_per_run`, `max_agent_calls_per_run`, `max_agent_calls_total`, `max_spawned_agents`, `max_tool_calls`, `max_tokens`, and `max_cost`
- `budget_state.usage`: observed counters for rounds, agent calls, spawned agents, tool calls, token/cost counters when available, and `stop_reason`
- `budget_state.remaining`: remaining capacity when a limit is numeric

Plain-goal sessions use conservative defaults compatible with the old behavior. Blueprint sessions can lower or raise caps within policy. The scheduler records machine-readable stop reasons such as `idle`, `completed`, `paused`, `blocker`, `convergence`, `max_rounds`, `ready_to_finish`, `agent_call_budget_exhausted`, and other budget exhaustion reasons.

## Graph and Trace Contract

Verbose session snapshots and `/api/cowork/sessions/{id}/graph` return a `cowork.graph.v2` projection with:

- `schema_version`, `generated_at`, `nodes`, `edges`, `stats`, and `truncated`
- node kinds including `session`, `agent`, `task`, `thread`, `mailbox`, `message`, `artifact`, `memory`, `decision`, and `budget`
- edge kinds including `member`, `assigned_to`, `depends_on`, `sent`, `delivered_to`, `replied_to`, `caused_by`, `blocks`, `produced`, `uses_memory`, `synthesizes`, `spawned`, and `parent_of`
- both `from`/`to` and `source`/`target` fields on every edge for old and new graph consumers
- aggregate hidden counts when a focused graph omits nodes or edges

Trace records merge user/agent messages, session events, scheduler decisions, trace spans, and derived stop reasons. Unknown event types are kept as generic trace records instead of being dropped.

## Branches and Results

Every session has a `default` Cowork Branch. A derived branch starts from a source branch and records a Stage Record with the derivation reason, inherited context summary, references, and decisions. The source branch remains available, and users may continue from either branch.

Branch completion creates a Branch Result with summary, artifacts, decision metadata, confidence, source architecture, and source branch id. A Branch Result does not automatically overwrite the session output. The session gets a Session Final Result only when the user explicitly selects a branch result or merges multiple branch results.

## Agent Steps and Observations

Agent Step is the smallest observable execution unit. Native steps include branch, architecture, agent, task or work-unit reference, scheduler reason, action kind, status, timing, linked messages/artifacts/tasks/envelopes, and a compact Step Summary. Legacy trace spans and events are projected into Agent Step-like payloads for UI compatibility.

Tool Observations record tool name, sanitized parameter summary, status, timing, and result summary. Browser Observations record purpose, resource reference, title, timing, result summary, artifacts, and sensitivity markers. Full Observation Detail is requested separately and can be `available`, `redacted`, `unavailable`, or denied by policy.

## Runtime Policy Developer Notes

Architecture-specific behavior belongs in `tinybot/cowork/policies/`. A policy should implement the capabilities that matter for its architecture: topology, branch initialization, step selection, envelope routing, delegation handling, completion evaluation, and organization projection.

Keep shared lifecycle, persistence, API snapshots, branch result selection, budget accounting, and generic observability in `CoworkService`. Add a new architecture by registering a policy in the registry, defining canonical projection sections, adding public service/API tests, and avoiding architecture-specific session subclasses.

## Structured Results and Intelligence

Agents can return structured task results as well as prose:

```json
{
  "task_id": "task_xxxxxxxx",
  "answer": "Recommended answer or completed work",
  "findings": ["Confirmed fact or useful observation"],
  "risks": ["Known caveat or failure mode"],
  "open_questions": ["Question still needing input"],
  "artifacts": ["Path, URL, or generated output"],
  "confidence": 0.82
}
```

Cowork stores this on the task, rolls recent completed work into shared session memory, and keeps a current final draft. The API and WebUI expose the session's `completion_decision`, `shared_summary`, and `final_draft` so users can see whether the team should run another round, resolve blockers, review failures, or summarize.

Mailbox records can also carry collaboration protocol hints:

- `topic`, `event_type`, `lineage_id`, and `caused_by_envelope_id`: event routing and lineage metadata for message-bus style workflows
- `request_type`: `clarify`, `verify`, `produce`, `review`, or `unblock`
- `expected_output_schema`: a lightweight shape for the expected reply
- `blocking_task_id`: the task currently waiting on the reply
- `escalate_after_rounds`: when the lead should intervene

## Current Scope

The implementation provides the core backend, tool interface, standalone CLI, API, and WebUI control plane. It supports persistent state, dynamic roles, discussion messages, architecture runtime policies, branch derivation, branch result selection/merge, Agent Step observability, repeated scheduling rounds, readiness scoring, structured results, blocker tracking, blueprint import/export, graph/trace observability, budget stop reasons, stale blocker escalation, and direct gateway access. Older stores remain JSON-compatible: missing blueprint, budget, graph, trace, lineage, memory, branches, Agent Steps, and decision fields default to empty or derived values during load.

## Migration Notes

Plain-goal Cowork still works through the existing planner and fallback team. Those generated sessions now include an exportable blueprint, so users can start with a simple goal, inspect the generated structure, export it, and then edit the JSON for repeatable future launches. Runtime-only messages, completed results, branch results, private summaries, and event history are not included in exported blueprints unless a future import format explicitly asks for them.

Stored `hybrid` workflow values are migration aliases. Loading a legacy session maps `hybrid` to `adaptive_starter` and creates a default Cowork Branch if branch metadata is absent. Compatibility aliases are accepted at input boundaries, but new UI, CLI, API, and blueprint output should use canonical architecture names.
