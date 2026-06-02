# Task System

The task system is for organizing multi-step goals that cannot be solved by one-shot responses. When an AI request requires planning and repeated actions, Tinybot can break it into tasks and execute them with traceable progress.

## What a task system does

You can think of it this way:

```text
Read README → inspect project files → identify issues → propose fixes → summarize outputs
```

Tinybot can usually perform this sequence:

1. Read README and docs
2. Inspect project config and execution steps
3. Verify code quality and structure
4. Check and enable required modules and settings
5. Return a concrete task report

If outputs look unreliable, ask for a clearer task breakdown and scope.

## Basic task types

| Type | Suggested use |
|------|------|
| `README + docs` triage | New projects, unfamiliar repositories |
| Code task list generation | New feature planning or maintenance prep |
| Long-running workflows | Scheduled or repeated processing |
| Risk and blocker review | Identify dependencies, risks, and unresolved issues |
| Evidence reporting | Include files, logs, and commands in the final output |

## How to send requests to task system

| Request type | Example |
|------|------|
| Quick scan | `Please read README and docs` |
| Result output | `Please output a risk checklist` |
| Runtime execution | `Please run checks and summarize` |
| Deployment readiness | `Please produce an action checklist for launch` |
| Regression check | `Please identify commands to run again for validation` |

## Task-oriented context controls

| Control | Meaning |
|----------|--------------|
| `scope` | Directory or repository scope, e.g., workspace |
| `workspace` | Path Tinybot should operate in |
| `persona` | Planning-focused or execution-focused behavior |
| `output` | Desired output format, e.g., Markdown table |

Example:

```text
Please read docs and README, inspect project setup, and output a deployment checklist.
```

After a long run:

```text
I asked for a project check and the task is complete. Please also list: changed files, verification steps, risks, and residual actions.
```

## Task progress view

### Runtime progress

Task progress shows status and completion per step so you can see what is currently running, completed, or blocked.

### Web UI

The web UI shows progress in task cards and each completed step, and it can also display agent-level execution traces.

## Manual and scheduled runs

Tinybot can execute task plans now or in the future if scheduled. You can continue a task even if workspace state changes.

Tips for stable tasks:

- Keep instructions deterministic and bounded.
- Ask for periodic checkpoints.
- For high-risk tasks, request a summary before each major change.

## Cancel and stop

| Area | Action |
|------|------|
| Runtime execution | Use `Ctrl+C` |
| Web UI | Click the stop button |

If a task is hard to stop, request a higher-level break and reissue with a tighter scope.

## Troubleshooting

### Task output is incomplete

Most likely causes:

```text
Workspace path ignored or incorrect; `.venv`, `.git`, and virtual env files should usually be excluded.
```

### Output format mismatch

Try this:

```text
Please output as Markdown. For each finding, include file path, command, and status.
```

### Too much content, not enough useful results

If useful, request:

```text
Summarize only key findings; do not execute tests or Python code.
```

## Next steps

- [Tool features](tools.md): better understand execution controls
- [Skills system](skills.md): lock stable task workflows into reusable behavior
- [Knowledge base](knowledge.md): improve consistency for repeated checks
