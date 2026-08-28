use super::{ProviderPlugin, OPENAI_API_MODES};
use crate::agent::provider::NativeProviderCatalogEntry;

pub(super) struct DeepSeekProvider;

pub(super) static PLUGIN: DeepSeekProvider = DeepSeekProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "deepseek",
    display_name: "DeepSeek",
    aliases: &["deep seek"],
    categories: &["built_in"],
    default_api_base: Some("https://api.deepseek.com"),
    api_key_env_vars: &["DEEPSEEK_API_KEY"],
    api_base_env_vars: &["DEEPSEEK_BASE_URL"],
    supports_model_discovery: true,
    curated_model_ids: &["deepseek-v4-pro", "deepseek-v4-flash"],
    model_prefixes: &["deepseek"],
    capabilities: &["reasoning"],
    supported_api_modes: OPENAI_API_MODES,
    backend: "openai",
};

impl ProviderPlugin for DeepSeekProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
    }
}
