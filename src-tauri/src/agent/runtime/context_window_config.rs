use super::AgentTurnContext;
use serde_json::Value;

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS: i64 = 128_000;
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS: &[(&str, i64)] = &[
    ("deepseek-v4-flash", 1_000_000),
    ("deepseek-v4-flash-vision-exp", 1_000_000),
    ("deepseek-v4-pro", 1_000_000),
    ("glm-5.3", 1_000_000),
    ("glm-5.3-flash", 1_000_000),
];

pub(super) fn resolve_context_window_tokens(context: &AgentTurnContext) -> i64 {
    turn_context_window_tokens(&context.spec)
        .or_else(|| profile_context_window_tokens(context))
        .or_else(|| default_context_window_tokens_for_model(&context.model))
        .or_else(|| legacy_context_window_fallback(&context.config_snapshot))
        .unwrap_or(DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS)
}

fn turn_context_window_tokens(spec: &Value) -> Option<i64> {
    positive_i64_field(spec, "contextWindowTokens")
        .or_else(|| positive_i64_field(spec, "context_window_tokens"))
}

fn profile_context_window_tokens(context: &AgentTurnContext) -> Option<i64> {
    crate::agent::provider::resolve_provider_profile(
        &context.config_snapshot,
        context.provider.as_deref(),
        None,
    )
    .and_then(|profile| profile.context_window_tokens_for_model(&context.model))
}

fn default_context_window_tokens_for_model(model: &str) -> Option<i64> {
    let normalized = model.trim();
    DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
        .iter()
        .find_map(|(model_id, tokens)| model_id.eq_ignore_ascii_case(normalized).then_some(*tokens))
}

fn legacy_context_window_fallback(config: &Value) -> Option<i64> {
    config
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| {
            positive_i64_field(defaults, "contextWindowTokens")
                .or_else(|| positive_i64_field(defaults, "context_window_tokens"))
        })
}

fn positive_i64_field(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
}
