mod catalog;
mod completion;
mod sse;

// Preserve the existing provider interface while implementation stays in focused modules.
#[allow(unused_imports)]
pub use catalog::{
    configured_model, list_provider_models, openai_models_body, provider_catalog_body,
    provider_models_body, resolve_provider_profile, NativeProviderCatalogEntry,
    NativeProviderModelList, NativeProviderModelsRequest, NativeProviderProfile,
};
#[allow(unused_imports)]
pub use completion::{
    complete_chat_for_agent_with_observer_async, openai_chat_completions_route_async,
    NativeProviderFailure, NativeProviderFailureKind,
};
pub use sse::NativeProviderStreamEvent;

#[cfg(test)]
pub use completion::{
    complete_chat_for_agent, complete_chat_for_agent_with_observer, openai_chat_completions_route,
};
#[cfg(test)]
use sse::{
    aggregate_chat_completion_sse, aggregate_chat_completion_sse_with_observer,
    stream_message_phase,
};

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
