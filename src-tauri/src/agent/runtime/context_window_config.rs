use super::AgentTurnContext;

pub(super) fn resolve_context_window_tokens(context: &AgentTurnContext) -> i64 {
    crate::agent::provider::resolve_model_context_window(
        &context.config_snapshot,
        context.provider.as_deref(),
        &context.model,
        context.controls.context_window_tokens,
    )
}
