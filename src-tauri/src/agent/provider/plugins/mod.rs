mod dashscope;
mod deepseek;
mod ollama;
mod openai;
mod zai;

use super::catalog::{
    normalize_provider_id, NativeProviderApiMode, NativeProviderCatalogEntry, NativeProviderProfile,
};
use serde_json::Value;

pub(super) const OPENAI_API_MODES: &[&str] = &["chat_completions", "responses"];
pub(super) const CHAT_COMPLETIONS_ONLY: &[&str] = &["chat_completions"];

pub(super) trait ProviderPlugin: Sync {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry;

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
    let provider_id = normalize_provider_id(provider_id);
    registered_provider_plugins().find(|plugin| {
        let entry = plugin.catalog_entry();
        entry.id == provider_id
            || entry
                .aliases
                .iter()
                .any(|alias| normalize_provider_id(alias) == provider_id)
    })
}

pub(crate) fn adapt_provider_request(
    profile: &NativeProviderProfile,
    model: &str,
    protocol: NativeProviderApiMode,
    request: &mut Value,
) -> Result<(), String> {
    let plugin = provider_plugin_by_id(&profile.provider_id);
    let effort_policy = if profile.supports_reasoning_effort {
        plugin
            .map(|plugin| plugin.reasoning_effort_policy(model))
            .unwrap_or(ReasoningEffortPolicy::PassThrough)
    } else {
        ReasoningEffortPolicy::Omit
    };
    normalize_reasoning_effort(&profile.provider_id, protocol, request, effort_policy)?;

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
    use std::collections::BTreeMap;

    #[test]
    fn registry_has_unique_provider_ids_and_aliases() {
        let mut owner_by_id = BTreeMap::new();
        for plugin in registered_provider_plugins() {
            let entry = plugin.catalog_entry();
            for candidate in std::iter::once(entry.id).chain(entry.aliases.iter().copied()) {
                let candidate = normalize_provider_id(candidate);
                assert_eq!(
                    owner_by_id.insert(candidate.clone(), entry.id),
                    None,
                    "provider registry key `{candidate}` is declared more than once"
                );
            }
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
