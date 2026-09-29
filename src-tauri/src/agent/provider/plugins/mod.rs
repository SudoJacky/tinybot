mod dashscope;
mod deepseek;
mod ollama;
mod openai;
mod zai;

use super::catalog::{NativeProviderApiMode, NativeProviderCatalogEntry, NativeProviderProfile};
use super::model::{ChatCompletionsCompat, ChatMaxTokensField};
use serde_json::Value;

pub(super) const OPENAI_API_MODES: &[&str] = &["chat_completions", "responses"];
pub(super) const CHAT_COMPLETIONS_ONLY: &[&str] = &["chat_completions"];

pub(super) trait ProviderPlugin: Sync {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry;

    fn chat_compat(&self, _model: &str) -> ChatCompletionsCompat {
        ChatCompletionsCompat::default()
    }

    fn reasoning_effort_policy(&self, _model: &str) -> ReasoningEffortPolicy {
        ReasoningEffortPolicy::PassThrough
    }

    fn adapt_request(
        &self,
        _context: ProviderRequestContext<'_>,
        _request: &mut Value,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(super) struct ProviderRequestContext<'a> {
    pub provider_id: &'a str,
    pub protocol: NativeProviderApiMode,
}

#[derive(Clone, Copy)]
pub(super) enum ReasoningEffortPolicy {
    PassThrough,
    Omit,
    AllowList(&'static [&'static str]),
}

impl ReasoningEffortPolicy {
    fn normalize(self, provider_id: &str, effort: &str) -> Result<Option<String>, String> {
        match self {
            Self::PassThrough => Ok(Some(effort.to_string())),
            Self::Omit => Ok(None),
            Self::AllowList(allowed) if allowed.contains(&effort) => Ok(Some(effort.to_string())),
            Self::AllowList(allowed) => Err(format!(
                "provider `{provider_id}` does not support reasoning effort `{effort}`; supported efforts: {}",
                allowed.join(", ")
            )),
        }
    }
}

static PROVIDER_PLUGINS: [&dyn ProviderPlugin; 5] = [
    &openai::PLUGIN,
    &deepseek::PLUGIN,
    &dashscope::PLUGIN,
    &zai::PLUGIN,
    &ollama::PLUGIN,
];

pub(super) fn registered_provider_plugins() -> impl Iterator<Item = &'static dyn ProviderPlugin> {
    PROVIDER_PLUGINS.iter().copied()
}

pub(super) fn provider_plugin_by_id(provider_id: &str) -> Option<&'static dyn ProviderPlugin> {
    registered_provider_plugins().find(|plugin| plugin.catalog_entry().id == provider_id)
}

pub(crate) fn adapt_provider_request(
    profile: &NativeProviderProfile,
    model: &str,
    protocol: NativeProviderApiMode,
    request: &mut Value,
) -> Result<(), String> {
    let plugin = provider_plugin_by_id(&profile.provider_id);
    let model = profile.resolve_model(model);
    normalize_reasoning_effort(
        &profile.provider_id,
        protocol,
        request,
        model.reasoning_effort_policy,
    )?;
    if protocol == NativeProviderApiMode::ChatCompletions {
        apply_chat_compat(&profile.provider_id, request, model.chat_compat)?;
    }

    if let Some(plugin) = plugin {
        plugin.adapt_request(
            ProviderRequestContext {
                provider_id: &profile.provider_id,
                protocol,
            },
            request,
        )?;
    }
    Ok(())
}

fn apply_chat_compat(
    provider_id: &str,
    request: &mut Value,
    compat: ChatCompletionsCompat,
) -> Result<(), String> {
    let request = request
        .as_object_mut()
        .ok_or_else(|| "provider request must be a JSON object".to_string())?;
    if !compat.supports_parallel_tool_calls
        && request.get("parallel_tool_calls").and_then(Value::as_bool) == Some(true)
    {
        return Err(format!(
            "provider `{provider_id}` does not declare support for `parallel_tool_calls`"
        ));
    }
    if !compat.supports_stream_usage {
        request.remove("stream_options");
    }
    if matches!(compat.max_tokens_field, ChatMaxTokensField::MaxTokens) {
        if request.contains_key("max_completion_tokens") && request.contains_key("max_tokens") {
            return Err(
                "provider request cannot contain both max_completion_tokens and max_tokens"
                    .to_string(),
            );
        }
        if let Some(max_tokens) = request.remove("max_completion_tokens") {
            request.insert("max_tokens".to_string(), max_tokens);
        }
    }
    Ok(())
}

fn normalize_reasoning_effort(
    provider_id: &str,
    protocol: NativeProviderApiMode,
    request: &mut Value,
    policy: ReasoningEffortPolicy,
) -> Result<(), String> {
    let effort = match protocol {
        NativeProviderApiMode::ChatCompletions => request
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_string),
        NativeProviderApiMode::Responses => request
            .pointer("/reasoning/effort")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let Some(effort) = effort else {
        return Ok(());
    };
    let normalized = policy.normalize(provider_id, &effort)?;

    match protocol {
        NativeProviderApiMode::ChatCompletions => {
            let request = request
                .as_object_mut()
                .ok_or_else(|| "provider request must be a JSON object".to_string())?;
            if let Some(effort) = normalized {
                request.insert("reasoning_effort".to_string(), Value::String(effort));
            } else {
                request.remove("reasoning_effort");
            }
        }
        NativeProviderApiMode::Responses => {
            let reasoning = request
                .get_mut("reasoning")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "Responses reasoning settings must be a JSON object".to_string())?;
            if let Some(effort) = normalized {
                reasoning.insert("effort".to_string(), Value::String(effort));
            } else {
                reasoning.remove("effort");
            }
            if reasoning.is_empty() {
                request
                    .as_object_mut()
                    .expect("provider request should remain a JSON object")
                    .remove("reasoning");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    #[test]
    fn registry_has_unique_provider_ids() {
        let mut ids = BTreeSet::new();
        for plugin in registered_provider_plugins() {
            let id = plugin.catalog_entry().id;
            assert!(
                ids.insert(id),
                "provider ID `{id}` is declared more than once"
            );
        }
    }

    #[test]
    fn effort_allow_list_accepts_supported_values_and_rejects_others() {
        assert_eq!(
            ReasoningEffortPolicy::AllowList(&["low", "high"])
                .normalize("fixture", "high")
                .unwrap()
                .as_deref(),
            Some("high")
        );
        assert!(ReasoningEffortPolicy::AllowList(&["low", "high"])
            .normalize("fixture", "medium")
            .unwrap_err()
            .contains("supported efforts"));
    }

    #[test]
    fn omitting_responses_effort_preserves_other_reasoning_fields() {
        let mut request = json!({ "reasoning": { "effort": "high", "summary": "auto" } });
        normalize_reasoning_effort(
            "fixture",
            NativeProviderApiMode::Responses,
            &mut request,
            ReasoningEffortPolicy::Omit,
        )
        .unwrap();

        assert_eq!(request["reasoning"]["summary"], "auto");
        assert!(request["reasoning"].get("effort").is_none());
    }
}
