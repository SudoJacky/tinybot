use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct WorkerConfigRpc {
    snapshot: Value,
    policy: CapabilityPolicy,
}

impl WorkerConfigRpc {
    pub fn new(snapshot: Value, policy: CapabilityPolicy) -> Self {
        Self { snapshot, policy }
    }

    pub fn get(&self, path: &str) -> Result<ConfigGetResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigRead)?;
        let segments = normalize_config_path(path)?;
        if segments.iter().any(|segment| is_sensitive_key(segment)) {
            return Err(sensitive_config_error(path));
        }
        let value = get_config_value(&self.snapshot, &segments)
            .map(redact_sensitive_value)
            .unwrap_or(Value::Null);
        Ok(ConfigGetResult {
            path: segments.join("."),
            value,
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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigGetResult {
    pub path: String,
    pub value: Value,
}

fn normalize_config_path(path: &str) -> Result<Vec<String>, WorkerProtocolError> {
    if path.is_empty() || path.contains('\0') {
        return Err(invalid_config_path(path));
    }
    let segments: Vec<String> = path.split('.').map(str::to_string).collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return Err(invalid_config_path(path));
    }
    Ok(segments)
}

fn get_config_value<'a>(snapshot: &'a Value, segments: &[String]) -> Option<&'a Value> {
    let mut current = snapshot;
    for segment in segments {
        current = current.get(segment)?;
    }
    Some(current)
}

fn redact_sensitive_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    if is_sensitive_key(key) {
                        (key.clone(), Value::Null)
                    } else {
                        (key.clone(), redact_sensitive_value(value))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.iter().map(redact_sensitive_value).collect())
        }
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "api_key" | "token" | "secret" | "password" | "credentials"
    )
}

fn invalid_config_path(path: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid config path",
        serde_json::json!({ "path": path }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn sensitive_config_error(path: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::CapabilityDenied,
        "worker config path is sensitive",
        serde_json::json!({ "path": path }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};
    use serde_json::json;

    #[test]
    fn default_policy_denies_config_get() {
        let rpc = WorkerConfigRpc::new(config_fixture(), CapabilityPolicy::default());

        let error = rpc
            .get("agents.defaults.model")
            .expect_err("config.get should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "config.read");
    }

    #[test]
    fn config_get_returns_nested_value_with_read_capability() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .get("agents.defaults.model")
            .expect("config.get should read public value");

        assert_eq!(result.path, "agents.defaults.model");
        assert_eq!(result.value, json!("gpt-5"));
    }

    #[test]
    fn config_get_returns_null_for_missing_public_path() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .get("agents.defaults.missing")
            .expect("missing public path should return null");

        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn config_get_rejects_sensitive_path_segments() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let error = rpc
            .get("providers.openai.api_key")
            .expect_err("api_key should be protected");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["path"], "providers.openai.api_key");
    }

    #[test]
    fn config_get_redacts_sensitive_descendants_from_objects() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .get("providers.openai")
            .expect("public parent object should read with redaction");

        assert_eq!(result.value["provider"], "openai");
        assert_eq!(result.value["api_key"], serde_json::Value::Null);
    }

    #[test]
    fn config_get_rejects_invalid_paths() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        assert!(rpc.get("").is_err());
        assert!(rpc.get(".agents").is_err());
        assert!(rpc.get("agents..defaults").is_err());
        assert!(rpc.get("agents.defaults.\0model").is_err());
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::ConfigRead])
    }

    fn config_fixture() -> serde_json::Value {
        json!({
            "agents": {
                "defaults": {
                    "model": "gpt-5",
                    "provider": "openai",
                    "workspace": "~/.tinybot/workspace"
                }
            },
            "providers": {
                "openai": {
                    "provider": "openai",
                    "api_key": "sk-secret",
                    "api_base": "https://api.openai.com/v1"
                }
            }
        })
    }
}
