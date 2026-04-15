A multi-step task plan has finished execution (may be completed or paused due to failure). Present the results to the user naturally.

## Plan: {{ title }}
**Status:** {{ status }}
**Plan ID:** {{ plan_id }}

## Results Summary
{{ summary }}

## Instructions
{% if status == "completed" %}
The plan has completed successfully. Summarize and present the results to the user in a clear, helpful format. Focus on the key outcomes and what was accomplished. Do not mention technical details like "plan_id" or "subtask".
{% elif status == "paused" %}
The plan has been paused due to a failure. Inform the user about the failure and the current progress. Suggest possible next steps such as:
1. Use `task action=status plan_id={{ plan_id }}` to inspect the detailed status
2. Use `task action=resume plan_id={{ plan_id }}` to retry execution after fixing issues
3. Use `task action=add_subtask` to add alternative subtasks
4. Use `task action=cancel plan_id={{ plan_id }}` to cancel the plan
Focus on the completed results so far and clearly explain what failed and why. Do not mention technical details like "plan_id" unless suggesting next steps.
{% endif %}