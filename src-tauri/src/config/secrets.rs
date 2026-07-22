use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct WorkerSecretRpc {
    snapshot: Value,
    policy: CapabilityPolicy,
}

impl WorkerSecretRpc {
    pub fn new(snapshot: Value, policy: CapabilityPolicy) -> Self {
        Self { snapshot, policy }
    }

    pub fn update_snapshot(&mut self, snapshot: Value) {
        self.snapshot = snapshot;
    }

    pub fn resolve_secret(
        &self,
        params: ProviderResolveSecretParams,
    ) -> Result<ProviderResolveSecretResult, WorkerProtocolError> {
        self.require(WorkerCapability::ProviderSecretRead)?;
        let provider_id = validate_provider_id(&params.provider_id)?;
        if let Some(profile_name) = params.profile_name.as_deref() {
            let profile_config = self
                .snapshot
                .get("providers")
                .and_then(|providers| providers.get("profiles"))
                .and_then(|profiles| profiles.get(profile_name));
            if let Some(api_key) = config_api_key(profile_config) {
                return Ok(ProviderResolveSecretResult {
                    api_key: Some(api_key),
                    api_key_source: Some("config".to_string()),
                });
            }
            if let Some(provider_id) = profile_config
                .and_then(|config| config.get("provider"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if let Some(result) = resolve_provider_env_secret(provider_id) {
                    return Ok(result);
                }
            }
        }
        if let Some(api_key) = config_api_key(
            self.snapshot
                .get("providers")
                .and_then(|providers| providers.get(provider_id)),
        ) {
            return Ok(ProviderResolveSecretResult {
                api_key: Some(api_key),
                api_key_source: Some("config".to_string()),
            });
        }
        if let Some(result) = resolve_provider_env_secret(provider_id) {
            return Ok(result);
        }
        Ok(ProviderResolveSecretResult {
            api_key: None,
            api_key_source: None,
        })
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderResolveSecretParams {
    #[serde(rename = "providerId", alias = "provider_id")]
    pub provider_id: String,
    #[serde(rename = "profileName", alias = "profile_name")]
    pub profile_name: Option<String>,
    #[serde(default, rename = "apiKeyEnvVars", alias = "api_key_env_vars")]
    pub api_key_env_vars: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ProviderResolveSecretResult {
    #[serde(rename = "apiKey", alias = "api_key")]
    pub api_key: Option<String>,
    #[serde(rename = "apiKeySource", alias = "api_key_source")]
    pub api_key_source: Option<String>,
}

fn config_api_key(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|config| config.get("api_key").or_else(|| config.get("apiKey")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_provider_env_secret(provider_id: &str) -> Option<ProviderResolveSecretResult> {
    for env_name in provider_api_key_env_vars(provider_id) {
        if let Ok(value) = std::env::var(env_name) {
            if !value.trim().is_empty() {
                return Some(ProviderResolveSecretResult {
                    api_key: Some(value),
                    api_key_source: Some(format!("env:{env_name}")),
                });
            }
        }
    }
    None
}

fn provider_api_key_env_vars(provider_id: &str) -> &'static [&'static str] {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        "openai" => &["OPENAI_API_KEY"],
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "dashscope" => &["DASHSCOPE_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
        "lm_studio" | "lm-studio" | "lmstudio" => &["LM_API_KEY"],
        "siliconflow" => &["SILICONFLOW_API_KEY"],
        "moonshot" => &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        "zhipu" => &[
            "ZHIPUAI_API_KEY",
            "ZHIPU_API_KEY",
            "GLM_API_KEY",
            "ZAI_API_KEY",
            "Z_AI_API_KEY",
        ],
        "vercel" => &["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"],
        "opencode" => &["OPENCODE_ZEN_API_KEY"],
        "opencode_go" | "opencode-go" => &["OPENCODE_GO_API_KEY"],
        "kilocode" => &["KILOCODE_API_KEY"],
        "huggingface" => &["HF_TOKEN", "HUGGINGFACE_API_KEY"],
        "novita" => &["NOVITA_API_KEY"],
        "nvidia" => &["NVIDIA_API_KEY"],
        "xiaomi" => &["XIAOMI_API_KEY"],
        "tencent_tokenhub" | "tencent-tokenhub" => &["TOKENHUB_API_KEY", "TENCENT_API_KEY"],
        "arcee" => &["ARCEE_API_KEY"],
        "gmi" => &["GMI_API_KEY"],
        "ollama_cloud" | "ollama-cloud" => &["OLLAMA_API_KEY"],
        _ => &[],
    }
}

fn validate_provider_id(provider_id: &str) -> Result<&str, WorkerProtocolError> {
    let value = provider_id.trim();
    if value.is_empty()
        || value.contains('.')
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid provider id",
            serde_json::json!({ "providerId": provider_id }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
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
                api_key_env_vars: vec![],
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

        let result = rpc
            .resolve_secret(ProviderResolveSecretParams {
                provider_id: "custom".to_string(),
                profile_name: None,
                api_key_env_vars: vec!["TINYBOT_ARBITRARY_WORKER_SECRET".to_string()],
            })
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
                api_key_env_vars: vec!["TINYBOT_ARBITRARY_WORKER_SECRET".to_string()],
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
            api_key_env_vars: vec![],
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
}
