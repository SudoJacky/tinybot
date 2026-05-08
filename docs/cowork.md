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

Send a message to agents:

```text
cowork action=send_message session_id="cw_xxxxxxxx" recipient_ids=["researcher"] content="Prioritize train travel."
```

## How Context Works

Each agent keeps its own private summary and inbox. Shared information moves through tasks, discussion threads, and completed task results. This keeps token use bounded because agents do not receive every other agent's full history on every round.

## Current Scope

The first implementation provides the core backend and tool interface. It supports persistent state, dynamic roles, discussion messages, and repeated scheduling rounds. A richer WebUI panel, artifact browser, approval workflow, and automatic long-running scheduler can build on the same session store.
