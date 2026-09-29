use super::catalog::{resolve_provider_profile, NativeProviderProfile};
use super::plugins::{provider_plugin_by_id, ReasoningEffortPolicy};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelDefaults {
    pub context_window_tokens: Option<i64>,
    pub input_modalities: Vec<String>,
}

impl Default for ModelDefaults {
    fn default() -> Self {
        Self {
            context_window_tokens: None,
            input_modalities: vec!["text".to_string()],
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelCatalog {
    fallback_context_window_tokens: i64,
    providers: BTreeMap<String, BTreeMap<String, ModelDefaults>>,
}

fn model_catalog() -> &'static ModelCatalog {
    static CATALOG: OnceLock<ModelCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("model-defaults.json"))
            .expect("bundled provider model defaults must be valid")
    })
}

fn builtin_model_defaults(provider: &str, model: &str) -> ModelDefaults {
    model_catalog()
        .providers
        .get(provider)
        .and_then(|models| models.get(model))
        .cloned()
        .unwrap_or_default()
}

#[derive(Clone, Copy, Default)]
pub(super) enum ChatMaxTokensField {
    #[default]
    MaxCompletionTokens,
    MaxTokens,
}

/// Only compatibility differences used by the registered providers belong here.
#[derive(Clone, Copy)]
pub(super) struct ChatCompletionsCompat {
    pub max_tokens_field: ChatMaxTokensField,
    pub supports_stream_usage: bool,
    pub supports_parallel_tool_calls: bool,
}

impl Default for ChatCompletionsCompat {
    fn default() -> Self {
        Self {
            max_tokens_field: ChatMaxTokensField::MaxCompletionTokens,
            supports_stream_usage: true,
            supports_parallel_tool_calls: true,
        }
    }
}

/// Model capabilities resolved within one Profile. Contains no credentials.
/// Provider defaults never transfer to another provider just because IDs match.
pub(crate) struct ResolvedModel {
    provider_id: String,
    pub context_window_tokens: Option<i64>,
    input_modalities: BTreeSet<String>,
    capabilities: Value,
    pub(super) reasoning_effort_policy: ReasoningEffortPolicy,
    pub(super) chat_compat: ChatCompletionsCompat,
}

impl ResolvedModel {
    pub(super) fn for_profile(profile: &NativeProviderProfile, model: &str) -> Self {
        let model = model.trim().to_ascii_lowercase();
        let plugin = provider_plugin_by_id(&profile.provider_id);
        let defaults = plugin
            .map(|plugin| builtin_model_defaults(plugin.catalog_entry().id, &model))
            .unwrap_or_default();
        Self {
            provider_id: profile.provider_id.clone(),
            context_window_tokens: profile
                .model_context_windows
                .get(&model)
                .copied()
                .or(defaults.context_window_tokens),
            input_modalities: profile
                .model_input_modalities
                .get(&model)
                .cloned()
                .unwrap_or_else(|| defaults.input_modalities.into_iter().collect()),
            capabilities: profile.capabilities.clone(),
            reasoning_effort_policy: if profile.supports_reasoning_effort {
                plugin
                    .map(|plugin| plugin.reasoning_effort_policy(&model))
                    .unwrap_or(ReasoningEffortPolicy::PassThrough)
            } else {
                ReasoningEffortPolicy::Omit
            },
            chat_compat: plugin
                .map(|plugin| plugin.chat_compat(&model))
                .unwrap_or_default(),
        }
    }

    pub fn supports_input_modality(&self, modality: &str) -> bool {
        self.input_modalities
            .contains(&modality.trim().to_ascii_lowercase())
    }

    pub fn require_capability(&self, capability: &str) -> Result<(), String> {
        let camel = match capability {
            "service_tier" => "serviceTier",
            "structured_output" => "structuredOutput",
            other => other,
        };
        let enabled = match &self.capabilities {
            Value::Object(values) => values
                .get(capability)
                .or_else(|| values.get(camel))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Value::Array(values) => values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|value| value == capability || value == camel)
            }),
            _ => false,
        };
        if enabled {
            Ok(())
        } else {
            Err(format!(
                "provider `{}` does not declare support for `{capability}`",
                self.provider_id
            ))
        }
    }
}

pub(crate) fn resolve_model_context_window(
    config: &Value,
    provider: Option<&str>,
    model: &str,
    request_override: Option<i64>,
) -> i64 {
    request_override
        .or_else(|| {
            resolve_provider_profile(config, provider, None)
                .and_then(|profile| profile.resolve_model(model).context_window_tokens)
        })
        .or_else(|| {
            let defaults = config.pointer("/agents/defaults")?;
            ["contextWindowTokens", "context_window_tokens"]
                .iter()
                .find_map(|key| {
                    defaults
                        .get(key)
                        .and_then(Value::as_i64)
                        .filter(|value| *value > 0)
                })
        })
        .unwrap_or_else(|| model_catalog().fallback_context_window_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profiles_and_request_overrides_have_explicit_precedence() {
        let config = json!({
            "agents": {"defaults": {"activeProfile": "work", "contextWindowTokens": 64000}},
            "providers": {"profiles": {
                "work": {"provider": "deepseek", "modelContextWindows": [
                    {"model": "deepseek-flash", "contextWindowTokens": 32000}
                ], "modelCapabilities": [{"model": "deepseek-flash", "inputModalities": ["text"]}]},
                "personal": {"provider": "deepseek"},
                "proxy": {"provider": "custom", "apiBase": "http://localhost/v1"}
            }}
        });
        let work = resolve_provider_profile(&config, None, Some("work")).unwrap();
        let personal = resolve_provider_profile(&config, None, Some("personal")).unwrap();
        let proxy = resolve_provider_profile(&config, None, Some("proxy")).unwrap();
        assert!(!work
            .resolve_model("deepseek-flash")
            .supports_input_modality("image"));
        assert!(personal
            .resolve_model("deepseek-flash")
            .supports_input_modality("image"));
        assert!(!proxy
            .resolve_model("deepseek-flash")
            .supports_input_modality("image"));
        assert_eq!(
            personal
                .resolve_model("DEEPSEEK-FLASH")
                .context_window_tokens,
            Some(1_000_000)
        );
        assert_eq!(
            proxy.resolve_model("deepseek-flash").context_window_tokens,
            None
        );
        assert_eq!(
            resolve_model_context_window(&config, None, "deepseek-flash", None),
            32000
        );
        assert_eq!(
            resolve_model_context_window(&config, None, "deepseek-flash", Some(16000)),
            16000
        );
        assert_eq!(
            resolve_model_context_window(&config, None, "unknown", None),
            64000
        );
        assert_eq!(
            resolve_model_context_window(&json!({}), None, "deepseek-flash", None),
            128000
        );
    }
}
