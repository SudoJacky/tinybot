use crate::config::store::{
    ConfigOperationRequest, ConfigPatchApplyResult, ConfigPatchBridgeResult,
    ConfigPatchSideEffects, ConfigStore, ConfigStoreError,
};
use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
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
#[path = "runtime_tests.rs"]
mod tests;
