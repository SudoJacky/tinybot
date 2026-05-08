# Cowork

Cowork is a persistent multi-agent workspace for goals that benefit from several specialized perspectives. It is not limited to software roles: Tinybot can create a team for research, travel planning, writing, analysis, operations, or other broad tasks.

## What It Adds

- Dynamic team planning from the user goal
- One persistent context per agent
- Agent inboxes and discussion threads
- A shared task list with per-agent ownership
- Session events for status and UI updates
- Agent-to-agent messages through the internal cowork tool

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
uv run tinybot cowork list
uv run tinybot cowork status cw_xxxxxxxx --verbose
uv run tinybot cowork run cw_xxxxxxxx --rounds 3
uv run tinybot cowork message cw_xxxxxxxx "Prioritize train travel" --to researcher
uv run tinybot cowork task cw_xxxxxxxx "Check rainy-day options" --agent analyst
uv run tinybot cowork summary cw_xxxxxxxx
```

This path constructs a standalone Cowork runtime instead of a full chat `AgentLoop`.

## WebUI and Gateway

When Tinybot is started with `tinybot gateway`, the hosted WebUI includes an independent Cowork entry in the right panel. The same workspace can also be opened directly at:

```text
http://127.0.0.1:<gateway-port>/cowork
```

The frontend calls the gateway Cowork API under `/api/cowork`, while normal chat, skills, knowledge, and workspace editing continue to use their existing routes.

Send a message to agents:

```text
cowork action=send_message session_id="cw_xxxxxxxx" recipient_ids=["researcher"] content="Prioritize train travel."
```

## How Context Works

Each agent keeps its own private summary and inbox. Shared information moves through tasks, discussion threads, and completed task results. This keeps token use bounded because agents do not receive every other agent's full history on every round.

## Current Scope

The implementation provides the core backend, tool interface, standalone CLI, and WebUI workspace. It supports persistent state, dynamic roles, discussion messages, repeated scheduling rounds, and direct gateway access. Artifact browsing, approval workflow, and an automatic long-running scheduler can build on the same session store.
