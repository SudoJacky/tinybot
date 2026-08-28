use super::{ProviderPlugin, OPENAI_API_MODES};
use crate::agent::provider::NativeProviderCatalogEntry;

pub(super) struct DashScopeProvider;

pub(super) static PLUGIN: DashScopeProvider = DashScopeProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "dashscope",
    display_name: "DashScope",
    aliases: &["dash scope", "model studio", "qwen"],
    categories: &["built_in"],
    default_api_base: Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    api_key_env_vars: &["DASHSCOPE_API_KEY"],
    api_base_env_vars: &["DASHSCOPE_BASE_URL"],
    supports_model_discovery: true,
    curated_model_ids: &["qwen-plus", "qwen-max", "qwen-turbo"],
    model_prefixes: &["qwen"],
    capabilities: &[],
    supported_api_modes: OPENAI_API_MODES,
    backend: "openai",
};

impl ProviderPlugin for DashScopeProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
    }
}
