use super::*;

pub(super) fn create_tool() -> ToolRegistryEntry {
    let mut entry = tool(
        CREATE_AUTOMATION_METHOD,
        "automation",
        "Create scheduled task",
        "Create a saved Tinybot task when the user asks to schedule future or recurring agent work. The task appears in Scheduled and can be edited or deleted there. Write self-contained instructions: these become a future user message, without replaying this chat into a new conversation. Defaults to the current workspace, a new conversation for each run, and application default model settings. Use execution.threadId='current' only when the user wants runs in this conversation. Supports once, daily, weekdays (Monday-Friday), and weekly on the starting weekday. Recurrences follow this computer's local timezone, even when startAt uses another UTC offset. Tinybot must remain running; hiding its window is fine, exiting stops scheduling. Missed occurrences coalesce into one run on resume, and runs of the same task never overlap. Saving does not run the task immediately, but a past start time becomes due on the next scheduler tick. Do not invent unsupported hourly, monthly, or cron schedules. After success, report the saved task, nextRunAt, and conversation choice; do not claim creation before the tool succeeds.",
        ToolExposure::Model,
        false,
        runtime_policy(false, ToolCancellationMode::DetachForbidden, false, false),
        vec![WorkerCapability::CronWrite, WorkerCapability::SessionMetadataRead],
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "instructions", "schedule"],
            "properties": {
                "name": {"type": "string", "minLength": 1, "description": "Short task name shown in Scheduled."},
                "instructions": {"type": "string", "minLength": 1, "description": "Complete instructions for each future run, including inputs, desired output, and output paths where relevant."},
                "workspacePath": {"type": "string", "minLength": 1, "description": "Absolute existing workspace directory. Omit to use this turn's workspace; required if the conversation has no workspace."},
                "schedule": {
                    "type": "object", "additionalProperties": false,
                    "required": ["repeat", "startAt"],
                    "properties": {
                        "repeat": {"type": "string", "enum": ["once", "daily", "weekdays", "weekly"]},
                        "startAt": {"type": "string", "description": "First occurrence as RFC 3339 with explicit UTC offset, e.g. 2026-09-15T09:00:00+08:00. Resolve relative dates from the current local time. Later occurrences follow the computer's local wall clock. For weekdays, a weekend start advances to Monday."}
                    }
                },
                "execution": {
                    "type": "object", "additionalProperties": false,
                    "properties": {
                        "threadId": {"type": "string", "minLength": 1, "description": "Omit for a new conversation each run; use 'current' for this conversation, or a known unarchived regular conversation ID in the selected workspace."},
                        "provider": {"type": "string", "minLength": 1, "description": "Optional configured provider ID; specify together with model only if the user requests a model override."},
                        "model": {"type": "string", "minLength": 1, "description": "Enabled model ID belonging to provider. Omit both to inherit application defaults at execution time."},
                        "profile": {"type": "string", "minLength": 1, "description": "Optional configured profile belonging to provider; requires provider and model."},
                        "reasoningEffort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Optional reasoning effort supported by the selected provider."}
                    }
                }
            }
        }),
    );
    entry.execution_target = ToolExecutionTarget::CreateAutomation;
    entry
}
