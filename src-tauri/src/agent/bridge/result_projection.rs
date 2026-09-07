pub(crate) fn native_agent_turn_id(value: &serde_json::Value) -> Option<String> {
    native_agent_string_field(value, "turnId")
        .or_else(|| native_agent_string_field(value, "turn_id"))
}

pub(crate) fn native_agent_model(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> String {
    native_agent_string_field(spec, "model")
        .or_else(|| native_agent_string_field(spec, "modelId"))
        .or_else(|| native_agent_string_field(spec, "model_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "model"))
        })
        .unwrap_or_else(|| crate::agent::provider::configured_model(config_snapshot))
}

pub(crate) fn native_agent_provider(
    spec: &serde_json::Value,
    config_snapshot: &serde_json::Value,
) -> Option<String> {
    native_agent_string_field(spec, "provider")
        .or_else(|| native_agent_string_field(spec, "providerId"))
        .or_else(|| native_agent_string_field(spec, "provider_id"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "provider"))
        })
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| native_agent_string_field(defaults, "provider"))
        })
}

pub(crate) fn native_agent_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
