#!/bin/sh
# Tinybot passes exactly one JSON object on stdin. Keep stdout JSON-only because
# Tinybot parses it as the hook decision. Write human diagnostics to stderr.
hook_input=$(cat)

# Parse $hook_input with your preferred JSON tool and emit one event response.
# UserPromptSubmit add context:
# printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Workspace policy checked."}}'
# UserPromptSubmit block:
# printf '%s\n' '{"continue":false,"stopReason":"Explain why this prompt is blocked."}'
# PreToolUse allow with replacement arguments:
# printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"path":"reviewed.md"}}}'
# PreToolUse deny:
# printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Explain why this call is blocked."}}'
# PostToolUse add context:
# printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Result reviewed."}}'
# PostToolUse replace the model-visible result (completed side effects are not undone):
# printf '%s\n' '{"continue":false,"stopReason":"Explain why the result should not be used."}'
# PostCompact add context:
# printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"Restore this durable context."}}'
# PostCompact stop the turn:
# printf '%s\n' '{"continue":false,"stopReason":"Explain why the turn should stop."}'

# Safe default: continue without changing Tinybot behavior.
printf '%s\n' '{}'
