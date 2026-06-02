# Skills System

Skills are work instructions for Tinybot. They tell the AI: when this type of task appears, what steps to follow, what to watch for, and what output format to produce.

## What problems skills are good for

If you find yourself repeatedly reminding Tinybot of the same behavior, consider making a skill.

| Repeated reminder | Candidate skill |
|----------|--------------|
| “When summarizing meetings, output by owner and due date” | Meeting summary skill |
| “Reviewing code: list risks first, don’t praise code immediately” | Code review skill |
| “Weekly report format: progress, risks, plan” | Weekly report skill |
| “For support tickets, classify first, then provide response script” | Support handling skill |

Skills do not replace model capability; they stabilize your preferences and workflow.

## Built-in skills

Tinybot includes built-in skills, including summarization, scheduling, memory management, browser workflows, and OpenCLI-related routines. You can view and toggle available skills in the web UI skill panel.

## How skills are triggered

Tinybot uses the skill description to decide whether to use it. You do not need to memorize names, but keep descriptions clear.

Example description:

```text
Use this when the user asks to summarize meeting notes, extract action items, and identify owners and due dates.
```

When users phrase requests like this, activation is easier:

```text
Please turn this meeting note into a list of action items.
```

## Create a custom skill

A skill is usually an `SKILL.md` file inside a directory. Basic format:

```markdown
---
name: meeting-summary
description: Use when the user asks to summarize meeting notes, action items, and risks.
---

# Meeting summary

## Steps
1. Identify meeting theme and context first.
2. Extract explicit action items.
3. If owner and due date are clear, list them separately.
4. Mark items without an explicit owner.

## Output format
Use Markdown table:

| Action item | Owner | Due date | Risk |
```

When writing a skill, prioritize three points:

| Content | Description |
|------|------|
| When to use | Write in `description` |
| How to work | Write steps |
| What to output | Provide format or example |

## Good vs weak skills

Good skill:

```text
When the user requests Python code review, first list concrete bugs, risks, and missing tests, then give a concise summary. Each issue should include file path, root cause, and suggestion.
```

Weak skill:

```text
Make the code good.
```

More specific skills produce more stable execution.

## Manage skills

### Web UI

In skill panel you can:

- View skill list
- Enable or disable skills
- View skill details
- Create or edit workspace skills

### Configuration file

You can control scope via `skills.enabled`:

```json
{
  "skills": {
    "enabled": ["*"]
  }
}
```

`["*"]` enables all available skills. You can also list specific skill names only.

## Skills vs knowledge base

| Capability | Purpose |
|------|------|
| Skills | Define how Tinybot should work |
| Knowledge base | Provide retrievable reference materials |

For example, “support response flow” is a good skill, while “product price list and policy text” belongs in the knowledge base.

## Common issues

### Skill not triggering

Check:

1. Whether the skill is enabled
2. Whether `description` clearly defines triggering scenarios
3. Whether the user request truly matches those scenarios
4. Whether another similar skill is overshadowing it

### Is a longer skill better?

Not necessarily. Keep skills short and explicit. Put stable rules in skills, temporary reference data in knowledge base, and context-specific details in chat.

### Need to restart after skill change?

Usually no. Restart conversation or refresh the web page. If skills list does not update, restart gateway.

## Next steps

- [Knowledge base](knowledge.md): manage long-term reference materials
- [Task system](tasks.md): understand multi-step execution
- [Web UI](webui.md): manage skills in browser
