use crate::agent::runtime::{
    AgentHook, AgentHookInvocation, AgentHookOutput, AgentHookRun, AgentHookStage,
};
use crate::command_hooks::{CommandHookEngine, CommandHookEvent, CommandHookRequest};
use futures_util::future::BoxFuture;

impl AgentHook for CommandHookEngine {
    fn name(&self) -> &'static str {
        "command_hooks"
    }
    fn evaluate<'a>(
        &'a self,
        invocation: &'a AgentHookInvocation,
    ) -> BoxFuture<'a, Result<AgentHookOutput, String>> {
        Box::pin(async move {
            let Some(request) = command_request(invocation) else {
                // No command ran at this stage, so there is no decision to record.
                return Ok(AgentHookOutput::Runs(Vec::new()));
            };
            let result = CommandHookEngine::evaluate(self, &request).await;
            Ok(AgentHookOutput::Runs(
                result
                    .runs
                    .into_iter()
                    .map(|run| AgentHookRun {
                        hook_hash: run.hook_hash,
                        hook_name: run.hook_name,
                        source_path: run.source_path.display().to_string(),
                        duration_ms: run.duration_ms,
                        decision: run.decision,
                        denied_reason: run.denied_reason,
                        updated_input: run.updated_input,
                        additional_context: run.additional_context,
                        system_message: run.system_message,
                        tool_feedback: run.tool_feedback,
                        failure: run.failure,
                    })
                    .collect(),
            ))
        })
    }
}

fn command_request(invocation: &AgentHookInvocation) -> Option<CommandHookRequest> {
    let event = match invocation.stage {
        AgentHookStage::UserPromptSubmit => CommandHookEvent::UserPromptSubmit,
        AgentHookStage::BeforeToolUse => CommandHookEvent::PreToolUse,
        AgentHookStage::AfterToolUse => CommandHookEvent::PostToolUse,
        AgentHookStage::CompactionComplete => CommandHookEvent::PostCompact,
        _ => return None,
    };
    Some(CommandHookRequest {
        event,
        session_id: invocation.session_id.clone().unwrap_or_default(),
        turn_id: invocation.trace_context.turn_id.clone(),
        model: invocation.model.clone().unwrap_or_default(),
        permission_mode: invocation
            .permission_mode
            .clone()
            .unwrap_or_else(|| "local-worker".to_string()),
        prompt: invocation.prompt.clone(),
        tool_name: invocation.tool_name.clone(),
        tool_match_names: invocation.tool_name.clone().into_iter().collect(),
        tool_use_id: invocation.tool_call_id.clone(),
        tool_input: invocation.normalized_input.clone(),
        tool_response: invocation.tool_response.clone(),
        trigger: invocation.compaction_trigger.clone(),
    })
}
