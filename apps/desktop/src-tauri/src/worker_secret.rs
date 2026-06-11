use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
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

    pub fn resolve_secret(
        &self,
        params: ProviderResolveSecretParams,
    ) -> Result<ProviderResolveSecretResult, WorkerProtocolError> {
        self.require(WorkerCapability::ProviderSecretRead)?;
        let provider_id = validate_provider_id(&params.provider_id)?;
        if let Some(profile_name) = params.profile_name.as_deref() {
            if let Some(api_key) = config_api_key(
                self.snapshot
                    .get("providers")
                    .and_then(|providers| providers.get("profiles"))
                    .and_then(|profiles| profiles.get(profile_name)),
            ) {
                return Ok(ProviderResolveSecretResult {
                    api_key: Some(api_key),
                    api_key_source: Some("config".to_string()),
                });
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
        for env_name in params.api_key_env_vars {
            if let Ok(value) = std::env::var(&env_name) {
                if !value.trim().is_empty() {
                    return Ok(ProviderResolveSecretResult {
                        api_key: Some(value),
                        api_key_source: Some(format!("env:{env_name}")),
                    });
                }
            }
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
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use serde_json::json;

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
}
