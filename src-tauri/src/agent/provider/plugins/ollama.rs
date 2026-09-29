use super::{
    ChatCompletionsCompat, ChatMaxTokensField, ProviderPlugin, ReasoningEffortPolicy,
    OPENAI_API_MODES,
};
use crate::agent::provider::NativeProviderCatalogEntry;

pub(super) struct OllamaProvider;

pub(super) static PLUGIN: OllamaProvider = OllamaProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "ollama",
    display_name: "Ollama",
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

    fn chat_compat(&self, _model: &str) -> ChatCompletionsCompat {
        ChatCompletionsCompat {
            max_tokens_field: ChatMaxTokensField::MaxTokens,
            ..ChatCompletionsCompat::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_completions_uses_ollamas_supported_max_tokens_field() {
        let mut request = json!({ "max_completion_tokens": 2048 });

        super::super::apply_chat_compat("ollama", &mut request, PLUGIN.chat_compat("qwen3:8b"))
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
