# Tinybot passes exactly one JSON object on stdin. Keep stdout JSON-only because
# Tinybot parses it as the hook decision. Write human diagnostics to stderr.
$hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$response = '{}'

# Inspect the common event name, then add only the policy your hook needs.
switch ($hookInput.hook_event_name) {
    "UserPromptSubmit" {
        # Add context:
        # $response = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Workspace policy checked."}}'
        # Block the prompt:
        # $response = '{"continue":false,"stopReason":"Explain why this prompt is blocked."}'
    }
    "PreToolUse" {
        # Allow with replacement arguments:
        # $response = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"path":"reviewed.md"}}}'
        # Deny the tool call:
        # $response = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Explain why this call is blocked."}}'
    }
    "PostToolUse" {
        # Add context:
        # $response = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Result reviewed."}}'
        # Replace the model-visible result (completed side effects are not undone):
        # $response = '{"continue":false,"stopReason":"Explain why the result should not be used."}'
    }
    "PostCompact" {
        # Add context after compaction:
        # $response = '{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"Restore this durable context."}}'
        # Stop the turn after compaction:
        # $response = '{"continue":false,"stopReason":"Explain why the turn should stop."}'
    }
}

# Emit exactly one response. The safe default continues without changing Tinybot behavior.
$response
