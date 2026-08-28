use super::{ProviderPlugin, OPENAI_API_MODES};
use crate::agent::provider::NativeProviderCatalogEntry;

pub(super) struct OpenAiProvider;

pub(super) static PLUGIN: OpenAiProvider = OpenAiProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "openai",
    display_name: "OpenAI",
    aliases: &["gpt", "chatgpt"],
    categories: &["built_in"],
    default_api_base: Some("https://api.openai.com/v1"),
    api_key_env_vars: &["OPENAI_API_KEY"],
    api_base_env_vars: &["OPENAI_BASE_URL"],
    supports_model_discovery: true,
    curated_model_ids: &["gpt-4.1"],
    model_prefixes: &["gpt", "o1", "o3", "o4"],
    capabilities: &[],
    supported_api_modes: OPENAI_API_MODES,
    backend: "openai",
};

impl ProviderPlugin for OpenAiProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
    }
}
