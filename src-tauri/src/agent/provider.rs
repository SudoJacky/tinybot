mod catalog;
mod completion;
mod streaming;

// Preserve the existing provider interface while implementation stays in focused modules.
#[allow(unused_imports)]
pub use catalog::{
    configured_model, list_provider_models, openai_models_body, provider_catalog_body,
    provider_models_body, resolve_provider_profile, NativeProviderCatalogEntry,
    NativeProviderModelList, NativeProviderModelsRequest, NativeProviderProfile,
};
#[allow(unused_imports)]
pub use completion::{
    complete_chat_for_agent_with_observer_async, NativeProviderFailure, NativeProviderFailureKind,
};
pub use streaming::NativeProviderStreamEvent;

#[cfg(test)]
pub use completion::{complete_chat_for_agent, complete_chat_for_agent_with_observer};
#[cfg(test)]
use streaming::{stream_message_phase, StreamingChatCompletion};

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
