use super::{ProviderPlugin, ProviderRequestContext, ReasoningEffortPolicy, OPENAI_API_MODES};
use crate::agent::provider::{NativeProviderApiMode, NativeProviderCatalogEntry};
use serde_json::Value;

pub(super) struct OllamaProvider;

pub(super) static PLUGIN: OllamaProvider = OllamaProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "ollama",
    display_name: "Ollama",
    aliases: &[],
    categories: &["built_in", "local"],
    default_api_base: Some("http://127.0.0.1:11434/v1"),
    api_key_env_vars: &[],
    api_base_env_vars: &[],
    supports_model_discovery: true,
    curated_model_ids: &[],
    model_prefixes: &[],
    capabilities: &[],
    supported_api_modes: OPENAI_API_MODES,
    backend: "openai",
};

impl ProviderPlugin for OllamaProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
    }

    fn reasoning_effort_policy(&self, _model: &str) -> ReasoningEffortPolicy {
        ReasoningEffortPolicy::AllowList(&["none", "low", "medium", "high"])
    }

    fn adapt_request(
        &self,
        context: ProviderRequestContext<'_>,
        request: &mut Value,
    ) -> Result<(), String> {
        if context.protocol != NativeProviderApiMode::ChatCompletions {
            return Ok(());
        }
        let request = request
            .as_object_mut()
            .ok_or_else(|| "provider request must be a JSON object".to_string())?;
        if let Some(max_tokens) = request.remove("max_completion_tokens") {
            request.insert("max_tokens".to_string(), max_tokens);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_completions_uses_ollamas_supported_max_tokens_field() {
        let mut request = json!({ "max_completion_tokens": 2048 });

        PLUGIN
            .adapt_request(
                ProviderRequestContext {
                    provider_id: "ollama",
                    protocol: NativeProviderApiMode::ChatCompletions,
                },
                &mut request,
            )
            .unwrap();

        assert_eq!(request["max_tokens"], 2048);
        assert!(request.get("max_completion_tokens").is_none());
    }

    #[test]
    fn reasoning_effort_matches_ollamas_supported_values() {
        let policy = PLUGIN.reasoning_effort_policy("qwen3:8b");

        assert_eq!(
            policy.normalize("ollama", "high").unwrap().as_deref(),
            Some("high")
        );
        assert_eq!(
            policy.normalize("ollama", "none").unwrap().as_deref(),
            Some("none")
        );
        assert!(policy.normalize("ollama", "xhigh").is_err());
    }
}
