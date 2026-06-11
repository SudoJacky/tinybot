use crate::config_store::{
    ConfigPatchApplyResult, ConfigPatchBridgeResult, ConfigPatchSideEffects, ConfigStore,
    ConfigStoreError,
};
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

    pub fn snapshot_public(&self) -> Result<ConfigSnapshotPublicResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigRead)?;
        Ok(ConfigSnapshotPublicResult {
            value: redact_sensitive_value(&self.snapshot),
        })
    }

    pub fn apply_patch_result(
        &mut self,
        result: ConfigPatchBridgeResult,
    ) -> Result<ConfigPatchApplyResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigWrite)?;
        if !result.ok {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: redact_sensitive_value(&self.snapshot),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: result.error,
            });
        }
        if !result.config.is_object() {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: redact_sensitive_value(&self.snapshot),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(
                    "validated config patch result must contain an object config".to_string(),
                ),
            });
        }

        self.snapshot = result.config;
        Ok(ConfigPatchApplyResult {
            ok: true,
            config: redact_sensitive_value(&self.snapshot),
            updated_fields: result.updated_fields,
            side_effects: result.side_effects,
            error: None,
        })
    }

    pub fn apply_patch_result_to_store(
        &mut self,
        store: &mut ConfigStore,
        result: ConfigPatchBridgeResult,
    ) -> Result<ConfigPatchApplyResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigWrite)?;
        let result = store
            .apply_validated_patch_result(result)
            .map_err(config_store_protocol_error)?;
        self.snapshot = store.snapshot().clone();
        Ok(ConfigPatchApplyResult {
            ok: result.ok,
            config: redact_sensitive_value(&result.config),
            updated_fields: result.updated_fields,
            side_effects: result.side_effects,
            error: result.error,
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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigSnapshotPublicResult {
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
        Value::Array(values) => Value::Array(values.iter().map(redact_sensitive_value).collect()),
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        key.as_str(),
        "apikey" | "token" | "secret" | "password" | "credentials"
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

fn config_store_protocol_error(error: ConfigStoreError) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        "failed to apply config patch result",
        serde_json::json!({ "error": error.to_string() }),
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
        let camel_case_error = rpc
            .get("providers.openai.apiKey")
            .expect_err("apiKey should be protected");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["path"], "providers.openai.api_key");
        assert_eq!(
            camel_case_error.code,
            WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(camel_case_error.details["path"], "providers.openai.apiKey");
    }

    #[test]
    fn config_get_redacts_sensitive_descendants_from_objects() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .get("providers.openai")
            .expect("public parent object should read with redaction");

        assert_eq!(result.value["provider"], "openai");
        assert_eq!(result.value["api_key"], serde_json::Value::Null);
        assert_eq!(result.value["apiKey"], serde_json::Value::Null);
    }

    #[test]
    fn config_snapshot_public_redacts_sensitive_descendants() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should read with redaction");

        assert_eq!(result.value["providers"]["openai"]["provider"], "openai");
        assert_eq!(
            result.value["providers"]["openai"]["api_key"],
            serde_json::Value::Null
        );
        assert_eq!(
            result.value["providers"]["openai"]["apiKey"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn config_get_rejects_invalid_paths() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        assert!(rpc.get("").is_err());
        assert!(rpc.get(".agents").is_err());
        assert!(rpc.get("agents..defaults").is_err());
        assert!(rpc.get("agents.defaults.\0model").is_err());
    }

    #[test]
    fn config_patch_result_requires_write_capability() {
        let mut rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let error = rpc
            .apply_patch_result(valid_patch_result())
            .expect_err("config patch should require write capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "config.write");
    }

    #[test]
    fn config_patch_result_updates_snapshot_and_returns_redacted_config() {
        let mut rpc = WorkerConfigRpc::new(config_fixture(), write_policy());

        let result = rpc
            .apply_patch_result(valid_patch_result())
            .expect("config patch result should apply");

        assert!(result.ok);
        assert_eq!(result.updated_fields, vec!["agents.defaults.model"]);
        assert_eq!(result.side_effects.applied, vec!["providerRuntimeChanged"]);
        assert_eq!(result.config["agents"]["defaults"]["model"], "gpt-5.1");
        assert_eq!(
            result.config["providers"]["openai"]["apiKey"],
            serde_json::Value::Null
        );
        assert_eq!(
            rpc.get("agents.defaults.model")
                .expect("updated config should be readable")
                .value,
            json!("gpt-5.1")
        );
    }

    #[test]
    fn config_patch_result_to_store_saves_and_returns_redacted_config() {
        let fixture = ConfigStoreFixture::new();
        let config_path = fixture.path("config.json");
        let mut store = ConfigStore::from_snapshot(config_path.clone(), config_fixture());
        let mut rpc = WorkerConfigRpc::new(store.snapshot().clone(), write_policy());

        let result = rpc
            .apply_patch_result_to_store(&mut store, valid_patch_result())
            .expect("config patch result should apply to store");

        assert!(result.ok);
        assert_eq!(result.config["agents"]["defaults"]["model"], "gpt-5.1");
        assert_eq!(
            result.config["providers"]["openai"]["apiKey"],
            serde_json::Value::Null
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(config_path).expect("patched config should save")
            )
            .expect("saved config should be JSON")["agents"]["defaults"]["model"],
            json!("gpt-5.1")
        );
        assert_eq!(
            rpc.get("agents.defaults.model")
                .expect("updated config should be readable")
                .value,
            json!("gpt-5.1")
        );
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::ConfigRead])
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::ConfigRead, WorkerCapability::ConfigWrite])
    }

    fn valid_patch_result() -> ConfigPatchBridgeResult {
        ConfigPatchBridgeResult {
            ok: true,
            config: json!({
                "agents": {
                    "defaults": {
                        "model": "gpt-5.1",
                        "provider": "openai"
                    }
                },
                "providers": {
                    "openai": {
                        "apiKey": "sk-new-secret"
                    }
                }
            }),
            updated_fields: vec!["agents.defaults.model".to_string()],
            side_effects: crate::config_store::ConfigPatchSideEffects {
                applied: vec!["providerRuntimeChanged".to_string()],
                restart_required: vec![],
                warnings: vec![],
            },
            error: None,
        }
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
                    "apiKey": "sk-camel-secret",
                    "api_base": "https://api.openai.com/v1"
                }
            }
        })
    }

    struct ConfigStoreFixture {
        root: std::path::PathBuf,
    }

    impl ConfigStoreFixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("tinybot-worker-config-store-test-{nonce}"));
            std::fs::create_dir_all(&root).expect("fixture root should create");
            Self { root }
        }

        fn path(&self, relative: &str) -> std::path::PathBuf {
            self.root.join(relative)
        }
    }

    impl Drop for ConfigStoreFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
