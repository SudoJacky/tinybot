# Provider Plugins
<!-- tinybot-module-fingerprint: sha256:e874bff5eddfd47f50d82dca4593eb379869900970625a0e7d5523a11492c1f8 -->

This module contains the statically registered adapters for built-in
Providers. A Provider plugin owns vendor-specific catalog metadata, reasoning
effort policy, and request-shape adaptations while the shared Chat Completions
and Responses flows remain in the runtime protocol adapters.

Plugins are compiled into Tinybot. They are not dynamically loaded libraries.

## When a Provider Plugin Is Enough

Add a Provider plugin when the Provider uses an OpenAI-compatible transport and
its differences are limited to matters such as:

- supported Chat Completions or Responses modes;
- model discovery and curated model metadata;
- supported or renamed reasoning effort values;
- ignored, renamed, rejected, or vendor-specific request fields.

Do not copy protocol-wide history, tool, streaming, or response decoding into a
Provider plugin. If a Provider changes authentication, endpoint construction,
stream events, or response shapes, extend the corresponding transport or
protocol Adapter at that seam instead.

## Integration Steps

### 1. Add a Provider module

Create one file per Provider, for example `acme.rs`. Define one stateless
Adapter and its catalog entry:

```rust
use super::{
    ProviderPlugin, ProviderRequestContext, ReasoningEffortPolicy,
    OPENAI_API_MODES,
};
use crate::agent::provider::{NativeProviderApiMode, NativeProviderCatalogEntry};
use serde_json::Value;

pub(super) struct AcmeProvider;

pub(super) static PLUGIN: AcmeProvider = AcmeProvider;

static CATALOG_ENTRY: NativeProviderCatalogEntry = NativeProviderCatalogEntry {
    id: "acme",
    display_name: "Acme",
    aliases: &["acme-ai"],
    categories: &["built_in"],
    default_api_base: Some("https://api.acme.example/v1"),
    api_key_env_vars: &["ACME_API_KEY"],
    api_base_env_vars: &["ACME_BASE_URL"],
    supports_model_discovery: true,
    curated_model_ids: &["acme-1"],
    model_prefixes: &["acme-"],
    capabilities: &[],
    supported_api_modes: OPENAI_API_MODES,
    backend: "openai",
};

impl ProviderPlugin for AcmeProvider {
    fn catalog_entry(&self) -> &'static NativeProviderCatalogEntry {
        &CATALOG_ENTRY
    }

    fn reasoning_effort_policy(&self, _model: &str) -> ReasoningEffortPolicy {
        ReasoningEffortPolicy::AllowList(&["low", "medium", "high"])
    }

    fn adapt_request(
        &self,
        context: ProviderRequestContext<'_>,
        request: &mut Value,
    ) -> Result<(), String> {
        if context.protocol == NativeProviderApiMode::Responses {
            request
                .as_object_mut()
                .ok_or_else(|| "provider request must be a JSON object".to_string())?
                .remove("store");
        }
        Ok(())
    }
}
```

Use `CHAT_COMPLETIONS_ONLY` instead of `OPENAI_API_MODES` when Responses is not
supported. Provider IDs and normalized aliases must be unique across the
registry.

### 2. Choose an effort policy

`reasoning_effort_policy` may return:

- `PassThrough`: send the frontend value unchanged;
- `Omit`: remove effort from the request;
- `AllowList`: accept only the listed values and fail visibly otherwise;
- `Map`: translate Tinybot values to Provider-native values and fail when a
  mapping is missing.

The method receives the model ID, so one Provider can select different policies
for different model families. A configured profile with
`supportsReasoningEffort: false` overrides the plugin and omits effort.

The shared normalizer writes the result to the correct protocol field:

| Protocol | Effort field |
| --- | --- |
| Chat Completions | `reasoning_effort` |
| Responses | `reasoning.effort` |

### 3. Adapt only vendor-specific request fields

The runtime constructs the standard request, applies common settings and tools,
then calls `adapt_request`. Match on `context.protocol` when a transformation
applies to only Chat Completions or Responses.

Return an actionable error for unsupported values or field combinations. Do
not silently downgrade an explicit user choice, and do not log credentials or
request payloads.

### 4. Register the plugin

Declare the module and add its singleton to `PROVIDER_PLUGINS` in `mod.rs`:

```rust
mod acme;

static PROVIDER_PLUGINS: [&dyn ProviderPlugin; 6] = [
    &openai::PLUGIN,
    &deepseek::PLUGIN,
    &dashscope::PLUGIN,
    &zai::PLUGIN,
    &ollama::PLUGIN,
    &acme::PLUGIN,
];
```

Registration makes the manifest available to catalog lookup, alias lookup, and
model-based Provider inference. Unregistered custom OpenAI-compatible profiles
continue to use the default pass-through request policy.

### 5. Add focused tests

At minimum, cover every non-default policy or request transformation:

- accepted, rejected, omitted, or mapped effort values;
- Chat Completions and Responses request shapes when both are supported;
- invalid field combinations and their error messages;
- manifest lookup through the Provider ID and aliases.

Keep tests at the plugin seam by asserting the final request shape or returned
error. Do not duplicate the shared protocol Adapter test suite in every plugin.

Run the focused checks with HDD-friendly Cargo concurrency:

```text
cargo test --manifest-path src-tauri/Cargo.toml --lib --jobs 4 agent::provider::plugins
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

## Frontend Exposure

Registering a backend plugin does not currently add a built-in Provider preset
to the settings UI. Existing custom Provider configuration can use the backend
adapter without frontend changes. If a new Provider must appear as a built-in
preset, update the frontend preset list as a separate product-facing change.

## Review Checklist

- The Provider is OpenAI-compatible at the transport and response levels.
- The manifest declares only protocols and capabilities the Provider supports.
- Provider IDs, aliases, model prefixes, and environment variables do not
  conflict with an existing plugin.
- Effort differences live in `reasoning_effort_policy`.
- Other wire-request differences live in `adapt_request` and are scoped by
  protocol where necessary.
- Unsupported explicit settings fail with clear errors.
- Focused request-shape and error-path tests pass.
- This README and the parent Provider README pass freshness checks.
