use crate::config_store::{
    ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult,
    ConfigPatchSideEffects, ConfigStore, ConfigStoreError,
};
use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug)]
pub struct WorkerConfigRpc {
    snapshot: Value,
    policy: CapabilityPolicy,
}

impl WorkerConfigRpc {
    pub fn new(snapshot: Value, policy: CapabilityPolicy) -> Self {
        Self { snapshot, policy }
    }

    pub fn snapshot(&self) -> &Value {
        &self.snapshot
    }

    pub fn get(&self, path: &str) -> Result<ConfigGetResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigRead)?;
        let segments = normalize_config_path(path)?;
        if segments.iter().any(|segment| is_sensitive_key(segment)) {
            return Err(sensitive_config_error(path));
        }
        let public_snapshot = public_config_snapshot(&self.snapshot);
        let value = get_config_value(&public_snapshot, &segments)
            .cloned()
            .unwrap_or(Value::Null);
        Ok(ConfigGetResult {
            path: segments.join("."),
            value,
        })
    }

    pub fn snapshot_public(&self) -> Result<ConfigSnapshotPublicResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigRead)?;
        Ok(ConfigSnapshotPublicResult {
            value: public_config_snapshot(&self.snapshot),
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
                config: public_config_snapshot(&self.snapshot),
                revision: None,
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: result.error,
            });
        }
        if !result.config.is_object() {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: public_config_snapshot(&self.snapshot),
                revision: None,
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
            config: public_config_snapshot(&self.snapshot),
            revision: None,
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
            config: public_config_snapshot(&result.config),
            revision: result.revision,
            updated_fields: result.updated_fields,
            side_effects: result.side_effects,
            error: result.error,
        })
    }

    pub fn apply_operations_to_store(
        &mut self,
        store: &mut ConfigStore,
        request: ConfigOperationRequest,
    ) -> Result<ConfigPatchApplyResult, WorkerProtocolError> {
        self.require(WorkerCapability::ConfigWrite)?;
        let result = store
            .apply_operations(request)
            .map_err(config_store_protocol_error)?;
        self.snapshot = store.snapshot().clone();
        Ok(ConfigPatchApplyResult {
            ok: result.ok,
            config: public_config_snapshot(&result.config),
            revision: result.revision,
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

fn public_config_snapshot(snapshot: &Value) -> Value {
    omit_sensitive_descendants(snapshot)
}

fn omit_sensitive_descendants(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut public = Map::new();
            let mut api_key_configured = false;
            for (key, value) in map {
                if is_sensitive_key(key) {
                    if is_api_key_key(key) && sensitive_value_configured(value) {
                        api_key_configured = true;
                    }
                    continue;
                }
                public.insert(key.clone(), omit_sensitive_descendants(value));
            }
            if api_key_configured {
                public.insert("api_key_configured".to_string(), Value::Bool(true));
            }
            Value::Object(public)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(omit_sensitive_descendants).collect())
        }
        other => other.clone(),
    }
}

fn is_api_key_key(key: &str) -> bool {
    normalized_config_key(key) == "apikey"
}

fn sensitive_value_configured(value: &Value) -> bool {
    value
        .as_str()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn is_sensitive_key(key: &str) -> bool {
    let key = normalized_config_key(key);
    matches!(
        key.as_str(),
        "apikey"
            | "token"
            | "secret"
            | "password"
            | "credentials"
            | "credential"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "privatekey"
    ) || key.ends_with("token")
        || key.ends_with("secret")
        || key.ends_with("password")
        || key.ends_with("credential")
        || key.ends_with("credentials")
        || key.ends_with("privatekey")
}

fn normalized_config_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
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
    fn config_get_rejects_common_sensitive_field_names() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        for path in [
            "providers.openai.access_token",
            "providers.openai.refreshToken",
            "providers.openai.client_secret",
            "providers.openai.privateKey",
            "providers.openai.password",
            "providers.openai.credentials",
        ] {
            let error = match rpc.get(path) {
                Ok(_) => panic!("{path} should be protected"),
                Err(error) => error,
            };
            assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
            assert_eq!(error.details["path"], path);
        }
    }

    #[test]
    fn config_get_omits_sensitive_descendants_from_public_objects() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .get("providers.openai")
            .expect("public parent object should read from public projection");

        assert_eq!(result.value["provider"], "openai");
        let provider = result
            .value
            .as_object()
            .expect("provider config should be an object");
        assert!(!provider.contains_key("api_key"));
        assert!(!provider.contains_key("apiKey"));
    }

    #[test]
    fn config_snapshot_public_omits_sensitive_descendants() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should read public projection");

        assert_eq!(result.value["providers"]["openai"]["provider"], "openai");
        let provider = result.value["providers"]["openai"]
            .as_object()
            .expect("provider config should be an object");
        assert!(!provider.contains_key("api_key"));
        assert!(!provider.contains_key("apiKey"));
    }

    #[test]
    fn config_snapshot_public_keeps_provider_secret_presence_metadata() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should read public projection");

        assert_eq!(
            result.value["providers"]["openai"]["api_key_configured"],
            json!(true)
        );
        assert!(result.value["providers"]["openai"].get("api_key").is_none());
        assert!(result.value["providers"]["openai"].get("apiKey").is_none());
    }

    #[test]
    fn config_snapshot_public_uses_explicit_public_contract() {
        let rpc = WorkerConfigRpc::new(config_fixture(), read_policy());

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should read with explicit public fields");

        assert_eq!(result.value["agents"]["defaults"]["model"], "gpt-5");
        assert_eq!(result.value["agents"]["defaults"]["provider"], "openai");
        assert_eq!(
            result.value["providers"]["openai"]["api_base"],
            "https://api.openai.com/v1"
        );
        let provider = result.value["providers"]["openai"]
            .as_object()
            .expect("provider public config should be an object");
        for key in [
            "api_key",
            "apiKey",
            "access_token",
            "refreshToken",
            "client_secret",
            "privateKey",
            "password",
            "credentials",
        ] {
            assert!(
                !provider.contains_key(key),
                "{key} should not be part of the public config contract"
            );
        }
    }

    #[test]
    fn config_snapshot_public_keeps_allowlisted_provider_fixture_data_without_nested_secrets() {
        let rpc = WorkerConfigRpc::new(
            json!({
                "providers": {
                    "fixture": {
                        "provider": "fixture",
                        "responses": [
                            {
                                "content": "fixture response",
                                "apiKey": "nested-secret"
                            }
                        ]
                    }
                }
            }),
            read_policy(),
        );

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should include allowlisted fixture data");

        assert_eq!(
            result.value["providers"]["fixture"]["responses"][0]["content"],
            "fixture response"
        );
        assert!(result.value["providers"]["fixture"]["responses"][0]
            .as_object()
            .unwrap()
            .get("apiKey")
            .is_none());
    }

    #[test]
    fn config_snapshot_public_preserves_non_secret_runtime_sections() {
        let rpc = WorkerConfigRpc::new(
            json!({
                "agents": {
                    "defaults": {
                        "model": "gpt-5",
                        "provider": "openai",
                        "maxToolIterations": 12,
                        "reasoningEffort": "medium",
                        "apiKey": "agent-secret"
                    }
                },
                "channels": {
                    "sendProgress": true,
                    "token": "channel-secret"
                },
                "gateway": {
                    "port": 18790,
                    "accessToken": "gateway-secret"
                },
                "tools": {
                    "mcpServers": {
                        "docs": {
                            "command": "docs-mcp",
                            "env": {
                                "DOCS_TOKEN": "mcp-secret",
                                "DOCS_URL": "https://docs.example.test"
                            }
                        }
                    }
                },
                "skills": {
                    "enabled": ["planner"]
                },
                "knowledge": {
                    "defaultCategory": "desktop"
                }
            }),
            read_policy(),
        );

        let result = rpc
            .snapshot_public()
            .expect("public snapshot should preserve non-secret runtime config");

        assert_eq!(result.value["agents"]["defaults"]["maxToolIterations"], 12);
        assert_eq!(
            result.value["agents"]["defaults"]["reasoningEffort"],
            "medium"
        );
        assert_eq!(result.value["channels"]["sendProgress"], true);
        assert_eq!(result.value["gateway"]["port"], 18790);
        assert_eq!(
            result.value["tools"]["mcpServers"]["docs"]["command"],
            "docs-mcp"
        );
        assert_eq!(
            result.value["tools"]["mcpServers"]["docs"]["env"]["DOCS_URL"],
            "https://docs.example.test"
        );
        assert_eq!(result.value["skills"]["enabled"][0], "planner");
        assert_eq!(result.value["knowledge"]["defaultCategory"], "desktop");
        assert!(result.value["agents"]["defaults"].get("apiKey").is_none());
        assert!(result.value["channels"].get("token").is_none());
        assert!(result.value["gateway"].get("accessToken").is_none());
        assert!(result.value["tools"]["mcpServers"]["docs"]["env"]
            .get("DOCS_TOKEN")
            .is_none());
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
        assert!(result
            .config
            .get("providers")
            .and_then(|providers| providers.get("openai"))
            .and_then(|provider| provider.get("apiKey"))
            .is_none());
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
        assert!(result
            .config
            .get("providers")
            .and_then(|providers| providers.get("openai"))
            .and_then(|provider| provider.get("apiKey"))
            .is_none());
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
                    "access_token": "access-secret",
                    "refreshToken": "refresh-secret",
                    "client_secret": "client-secret",
                    "privateKey": "private-secret",
                    "password": "password-secret",
                    "credentials": { "token": "nested-secret" },
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
