use super::{ProviderPlugin, ProviderRequestContext, CHAT_COMPLETIONS_ONLY};
use crate::agent::provider::{NativeProviderApiMode, NativeProviderCatalogEntry};
use serde_json::Value;

pub(super) struct ZaiProvider;

pub(super) static PLUGIN: ZaiProvider = ZaiProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "zai",
    display_name: "Z.ai",
    aliases: &["z.ai", "zhipu", "bigmodel"],
    categories: &["built_in"],
    default_api_base: Some("https://open.bigmodel.cn/api/paas/v4"),
    api_key_env_vars: &["ZAI_API_KEY"],
    api_base_env_vars: &["ZAI_BASE_URL"],
    supports_model_discovery: false,
    curated_model_ids: &["glm-5.3", "glm-5.3-flash", "glm-5.2"],
    model_prefixes: &["glm"],
    capabilities: &[],
    supported_api_modes: CHAT_COMPLETIONS_ONLY,
    backend: "openai",
};

impl ProviderPlugin for ZaiProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
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
        if let Some(temperature) = request.get("temperature").and_then(Value::as_f64) {
            if !(temperature > 0.0 && temperature <= 1.0) {
                return Err(format!(
                    "provider `{}` temperature must be greater than 0 and at most 1, got {temperature}",
                    context.provider_id
                ));
            }
        }
        if request.get("parallel_tool_calls").and_then(Value::as_bool) == Some(true) {
            return Err(format!(
                "provider `{}` does not declare support for `parallel_tool_calls`",
                context.provider_id
            ));
        }
        request.remove("stream_options");
        if let Some(max_tokens) = request.remove("max_completion_tokens") {
            request.insert("max_tokens".to_string(), max_tokens);
        }
        Ok(())
    }
}
