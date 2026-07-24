use super::*;
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use serde_json::json;
use std::sync::{Mutex, OnceLock};

#[test]
fn resolve_secret_requires_provider_secret_capability() {
    let rpc = WorkerSecretRpc::new(secret_fixture(), CapabilityPolicy::default());

    let error = rpc
        .resolve_secret(params("openai"))
        .expect_err("secret reads should require capability");

    assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
    assert_eq!(error.details["capability"], "provider.secret.read");
}

#[test]
fn resolve_secret_prefers_profile_key() {
    let rpc = WorkerSecretRpc::new(
        secret_fixture(),
        CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
    );

    let result = rpc
        .resolve_secret(ProviderResolveSecretParams {
            provider_id: "dashscope".to_string(),
            profile_name: Some("dashscope-search".to_string()),
        })
        .expect("profile secret should resolve");

    assert_eq!(
        result,
        ProviderResolveSecretResult {
            api_key: Some("profile-secret".to_string()),
            api_key_source: Some("config".to_string()),
        }
    );
}

#[test]
fn resolve_secret_rejects_arbitrary_path_provider_ids() {
    let rpc = WorkerSecretRpc::new(
        secret_fixture(),
        CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
    );

    let error = rpc
        .resolve_secret(params("providers.openai.api_key"))
        .expect_err("provider id is not a config path");

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
}

#[test]
fn resolve_secret_ignores_worker_supplied_env_var_names() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _env = EnvVarGuard::set("TINYBOT_ARBITRARY_WORKER_SECRET", "leaked-secret");
    let rpc = WorkerSecretRpc::new(
        json!({ "providers": { "custom": { "provider": "custom" } } }),
        CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
    );

    let params = serde_json::from_value(json!({
        "providerId": "custom",
        "profileName": null,
        "apiKeyEnvVars": ["TINYBOT_ARBITRARY_WORKER_SECRET"]
    }))
    .expect("legacy env-name input should deserialize without becoming executable");
    let result = rpc
        .resolve_secret(params)
        .expect("arbitrary worker env names should not fail protocol parsing");

    assert_eq!(
        result,
        ProviderResolveSecretResult {
            api_key: None,
            api_key_source: None,
        }
    );
}

#[test]
fn resolve_secret_uses_rust_owned_provider_env_mapping() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _env = EnvVarGuard::set("OPENAI_API_KEY", "rust-owned-env-secret");
    let rpc = WorkerSecretRpc::new(
        json!({ "providers": { "openai": { "provider": "openai" } } }),
        CapabilityPolicy::new([WorkerCapability::ProviderSecretRead]),
    );

    let result = rpc
        .resolve_secret(ProviderResolveSecretParams {
            provider_id: "openai".to_string(),
            profile_name: None,
        })
        .expect("provider-owned env mapping should resolve");

    assert_eq!(
        result,
        ProviderResolveSecretResult {
            api_key: Some("rust-owned-env-secret".to_string()),
            api_key_source: Some("env:OPENAI_API_KEY".to_string()),
        }
    );
}

fn params(provider_id: &str) -> ProviderResolveSecretParams {
    ProviderResolveSecretParams {
        provider_id: provider_id.to_string(),
        profile_name: None,
    }
}

fn secret_fixture() -> Value {
    json!({
        "providers": {
            "openai": { "api_key": "openai-secret" },
            "profiles": {
                "dashscope-search": {
                    "provider": "dashscope",
                    "api_key": "profile-secret"
                }
            }
        }
    })
}

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct EnvVarGuard {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = self.previous.take() {
            std::env::set_var(self.name, value);
        } else {
            std::env::remove_var(self.name);
        }
    }
}
