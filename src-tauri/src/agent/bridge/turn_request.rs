use crate::agent::runtime::{AgentError, AgentTurnInput, TurnInstructionInput};
use crate::threads::rollout::format::{ResponseItem, TurnContextItem};
use serde_json::Value;
use std::path::Path;

/// Protocol decoding ends here; orchestration owns normalized execution and durability inputs.
pub(crate) struct AgentTurnRequest {
    pub input: AgentTurnInput,
    pub instructions: TurnInstructionInput,
    pub context: TurnContextItem,
    pub user_message: Option<ResponseItem>,
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
        let user_message = super::history::native_agent_current_user_message(&spec)
            .map(|mut user| {
                user["type"] = Value::String("message".into());
                user["role"] = Value::String("user".into());
                let id = user
                    .get("id")
                    .or_else(|| user.get("messageId"))
                    .cloned()
                    .unwrap_or_else(|| {
                        Value::String(format!("user:{}", input.trace_context.turn_id))
                    });
                user["id"] = id.clone();
                user["messageId"] = id;
                user["turnId"] = Value::String(input.trace_context.turn_id.clone());
                ResponseItem::from_value(user).map_err(AgentError::invalid_input)
            })
            .transpose()?;
        Ok(Self {
            input,
            instructions,
            context,
            user_message,
        })
    }
}
