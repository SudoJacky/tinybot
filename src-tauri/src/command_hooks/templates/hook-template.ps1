# Tinybot passes exactly one JSON object on stdin. Keep stdout JSON-only because
# Tinybot parses it as the hook decision. Write human diagnostics to stderr.
$hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json

# Inspect the common event name, then add only the policy your hook needs.
switch ($hookInput.hook_event_name) {
    "UserPromptSubmit" {
        # Add context:
        # '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Workspace policy checked."}}'
        # Block the prompt:
        # '{"continue":false,"stopReason":"Explain why this prompt is blocked."}'
    }
    "PreToolUse" {
        # Allow with replacement arguments:
        # '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"path":"reviewed.md"}}}'
        # Deny the tool call:
        # '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Explain why this call is blocked."}}'
    }
    "PostToolUse" {
        # Add context:
        # '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Result reviewed."}}'
        # Replace the model-visible result (completed side effects are not undone):
        # '{"continue":false,"stopReason":"Explain why the result should not be used."}'
    }
    "PostCompact" {
        # Add context after compaction:
        # '{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"Restore this durable context."}}'
        # Stop the turn after compaction:
        # '{"continue":false,"stopReason":"Explain why the turn should stop."}'
    }
}

# Safe default: continue without changing Tinybot behavior.
'{}'
