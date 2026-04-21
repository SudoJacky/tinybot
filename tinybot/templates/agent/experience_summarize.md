Analyze the conversation and extract reusable experiences.

The output must use this exact text format:

```text
SUMMARY: <one sentence describing the user problem or request pattern>
---
EXPERIENCE:
experience_type: <workflow|recovery|reference>
trigger_stage: <before_plan|before_tool|on_error|after_success|general>
tool_name: <tool name or general>
error_type: <exception type, or success if not error-driven>
category: <path|permission|encoding|network|api|config|dependency|general>
tags: <comma-separated tags>
action_hint: <primary recommended action>
applicability: <when this experience should be applied>
resolution: <short reusable explanation or procedure>
confidence: <0.3-1.0>
---
```

Rules:
- Extract only experiences that are likely reusable.
- Prefer `workflow` when the conversation reveals a reusable handling process.
- Prefer `recovery` when the conversation shows how to recover from a tool failure.
- Use `before_plan` for request-level workflows and `on_error` for recoveries.
- Keep `action_hint` concrete and imperative.
- Keep `resolution` short and reusable.
- If nothing useful should be stored, output:

```text
SUMMARY: <brief description>
SKIP: no reusable experience
```
