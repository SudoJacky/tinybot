#!/bin/sh
# Tinybot passes exactly one JSON object on stdin. Keep stdout JSON-only because
# Tinybot parses it as the hook decision. Write human diagnostics to stderr.
hook_input=$(cat)
response='{}'

# Parse $hook_input with your preferred JSON tool and emit one event response.
# UserPromptSubmit add context:
# response='{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Workspace policy checked."}}'
# UserPromptSubmit block:
# response='{"continue":false,"stopReason":"Explain why this prompt is blocked."}'
# PreToolUse allow with replacement arguments:
# response='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"path":"reviewed.md"}}}'
# PreToolUse deny:
# response='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Explain why this call is blocked."}}'
# PostToolUse add context:
# response='{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Result reviewed."}}'
# PostToolUse replace the model-visible result (completed side effects are not undone):
# response='{"continue":false,"stopReason":"Explain why the result should not be used."}'
# PostCompact add context:
# response='{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"Restore this durable context."}}'
# PostCompact stop the turn:
# response='{"continue":false,"stopReason":"Explain why the turn should stop."}'

# Emit exactly one response. The safe default continues without changing Tinybot behavior.
printf '%s\n' "$response"
