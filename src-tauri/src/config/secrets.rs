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
#[path = "secrets_tests.rs"]
mod tests;
