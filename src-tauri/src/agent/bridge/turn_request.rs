use crate::agent::runtime::{AgentError, AgentItem, AgentTurnInput, TurnInstructionInput};
use crate::threads::rollout::format::{ResponseItem, TurnContextItem};
use serde_json::Value;
use std::path::Path;

/// Protocol decoding ends here; orchestration owns normalized execution and durability inputs.
pub(crate) struct AgentTurnRequest {
    pub input: AgentTurnInput,
    pub instructions: TurnInstructionInput,
    pub context: TurnContextItem,
    pub user_messages: Vec<ResponseItem>,
}

impl AgentTurnRequest {
    pub(crate) fn from_wire(
        mut spec: Value,
        config: &Value,
        workspace: &Path,
    ) -> Result<Self, AgentError> {
        // Validate before trace initialization can replace malformed identity fields.
        let mut input =
            AgentTurnInput::from_wire(&spec, config).map_err(AgentError::invalid_input)?;
        input.trace_context = crate::agent::runtime::ensure_agent_trace_context(&mut spec)
            .map_err(AgentError::invalid_input)?;
        let instructions =
            TurnInstructionInput::from_wire(&spec, workspace).map_err(AgentError::invalid_input)?;
        let context = super::persistence::native_agent_turn_context(
            &spec,
            config,
            &input.trace_context.turn_id,
        )?;
        // An attached turn accepts new input, not a client copy of durable history.
        // Standalone execution and checkpoint resume keep their explicit history paths.
        let mut user_messages = Vec::new();
        if !input.controls.manual_compaction {
            if spec
                .get("responseItems")
                .or_else(|| spec.get("response_items"))
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                return Err(AgentError::invalid_input(
                    "attached turns load Responses history from Rollout; responseItems cannot supply history",
                ));
            }
            for item in &mut input.messages.items {
                let user = match item {
                    AgentItem::Instruction(_) => continue,
                    AgentItem::UserMessage(user) => user,
                    _ => return Err(AgentError::invalid_input(
                        "attached turns accept only new user messages and current instructions; history is loaded from Rollout",
                    )),
                };
                let thread_id = input
                    .trace_context
                    .thread_id
                    .as_ref()
                    .unwrap_or(&input.session_id);
                if user.origin.rollout_ordinal.is_some() || user.origin.context_id.is_some() {
                    return Err(AgentError::invalid_input(
                        "new user input cannot supply a Rollout or checkpoint source",
                    ));
                }
                if user
                    .origin
                    .turn_id
                    .as_ref()
                    .is_some_and(|id| id != &input.trace_context.turn_id)
                    || user
                        .origin
                        .thread_id
                        .as_ref()
                        .is_some_and(|id| id != thread_id)
                {
                    return Err(AgentError::invalid_input(
                        "new user message belongs to another thread or turn",
                    ));
                }
                let id = user
                    .origin
                    .message_id
                    .clone()
                    .or_else(|| user.id.clone())
                    .unwrap_or_else(|| {
                        if user_messages.is_empty() {
                            format!("user:{}", input.trace_context.turn_id)
                        } else {
                            format!(
                                "user:{}:{}",
                                input.trace_context.turn_id,
                                user_messages.len()
                            )
                        }
                    });
                if id.trim().is_empty() || user.id.as_ref().is_some_and(|value| value != &id) {
                    return Err(AgentError::invalid_input(
                        "new user message requires a consistent, nonempty id/messageId",
                    ));
                }
                user.id = Some(id.clone());
                user.origin.message_id = Some(id);
                user.origin.turn_id = Some(input.trace_context.turn_id.clone());
                user.origin.thread_id = Some(thread_id.clone());
                let mut message = item
                    .to_legacy_message()
                    .map_err(AgentError::invalid_input)?;
                message["type"] = "message".into();
                user_messages
                    .push(ResponseItem::from_value(message).map_err(AgentError::invalid_input)?);
            }
        }
        Ok(Self {
            input,
            instructions,
            context,
            user_messages,
        })
    }
}
