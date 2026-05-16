# Task Planning

The task module is a lightweight planning and execution manager for decomposed work inside a normal agent session. It is separate from Cowork: task plans organize one agent's work, while Cowork coordinates multiple persistent agents.

## Ownership

| Concern | Module |
| --- | --- |
| Task and plan dataclasses | `tinybot/task/types.py` |
| Plan creation and execution | `tinybot/task/service.py` |
| Agent tool surface | `tinybot/agent/tools/task.py` |
| CLI/WebUI progress display | `tinybot/cli/commands.py`, gateway session payloads |

## Design Intent

Task planning gives the agent an explicit work graph for complex requests. The manager stores a plan, validates dependency shape, executes ready subtasks, records progress, and emits progress snapshots that callers can display.

The design should stay focused on bounded decomposition. It is not a general workflow engine and should not grow into a second Cowork runtime.

## Logical Flow

1. A user request or tool call asks for a plan.
2. The manager asks the model to produce bounded subtasks.
3. The plan is validated as a DAG.
4. Ready subtasks execute according to dependency and parallelism rules.
5. Each subtask records status, result, retry state, and error.
6. Progress snapshots are written and emitted to the caller.
7. The final plan summary is returned to the agent or user.

## Planning Principles

- Subtasks should be concrete and verifiable.
- Dependencies should represent real ordering constraints, not just narration.
- Failed subtasks should preserve enough context for retry or user explanation.
- Parallelism should be conservative and visible.
- A task plan should complete into a summary, not leak internal execution details by default.

## Boundaries

- The task module can call back into an agent executor, but it should not know provider internals.
- It can persist task plans, but normal chat message history remains owned by the session layer.
- It should not manage multi-agent mailbox, branches, or architecture policies. Those belong to Cowork.

## Extension Points

- Add new plan metadata in `types.py` and hydration logic in the service.
- Add new execution strategies in the manager, with tests for ready/blocked/failed paths.
- Add new progress fields only when CLI/WebUI need them and tests cover their shape.

## Test Strategy

Use `tests/task/` for planning strategy, DAG behavior, execution ordering, retries, and blocked/completed plan states. If the agent tool surface changes, add tests in `tests/tools/` or agent tool tests as appropriate.
