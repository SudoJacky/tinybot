use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{hash_map::DefaultHasher, BTreeMap},
    error::Error,
    fmt, fs,
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct ConfigStore {
    config_path: PathBuf,
    snapshot: Value,
    diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigDiagnostic {
    pub level: ConfigDiagnosticLevel,
    pub code: ConfigDiagnosticCode,
    pub message: String,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigDiagnosticLevel {
    Info,
    Warning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigDiagnosticCode {
    MissingConfig,
    InvalidJson,
    InvalidConfig,
    AliasConflict,
}

#[derive(Debug)]
pub enum ConfigStoreError {
    Io {
        path: PathBuf,
        source: io::Error,
    },
    Serialize {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchBridgeResult {
    pub ok: bool,
    pub config: Value,
    #[serde(rename = "updatedFields", alias = "updated_fields")]
    pub updated_fields: Vec<String>,
    #[serde(rename = "sideEffects", alias = "side_effects", default)]
    pub side_effects: ConfigPatchSideEffects,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchApplyResult {
    pub ok: bool,
    pub config: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(rename = "updatedFields", alias = "updated_fields")]
    pub updated_fields: Vec<String>,
    #[serde(rename = "sideEffects", alias = "side_effects")]
    pub side_effects: ConfigPatchSideEffects,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct ConfigPatchSideEffects {
    pub applied: Vec<String>,
    #[serde(rename = "restartRequired", alias = "restart_required")]
    pub restart_required: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigEditorSnapshot {
    #[serde(rename = "configPath", alias = "config_path")]
    pub config_path: PathBuf,
    pub revision: String,
    #[serde(rename = "explicitPublicConfig", alias = "explicit_public_config")]
    pub explicit_public_config: Value,
    #[serde(rename = "effectivePublicConfig", alias = "effective_public_config")]
    pub effective_public_config: Value,
    pub origins: BTreeMap<String, String>,
    pub diagnostics: Vec<ConfigDiagnostic>,
    #[serde(rename = "secretPresence", alias = "secret_presence")]
    pub secret_presence: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ConfigOperationRequest {
    #[serde(rename = "expectedRevision", alias = "expected_revision")]
    pub expected_revision: Option<String>,
    pub operations: Vec<ConfigOperation>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ConfigOperation {
    Replace { path: String, value: Value },
    Remove { path: String },
    SecretReplace { path: String, value: Value },
    SecretRemove { path: String },
}

impl ConfigStore {
    pub fn load(config_path: PathBuf, default_snapshot: Value) -> Result<Self, ConfigStoreError> {
        match fs::read_to_string(&config_path) {
            Ok(contents) => Ok(Self::load_from_text(
                config_path,
                contents,
                default_snapshot,
            )),
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(Self {
                config_path: config_path.clone(),
                snapshot: default_snapshot,
                diagnostics: vec![ConfigDiagnostic {
                    level: ConfigDiagnosticLevel::Info,
                    code: ConfigDiagnosticCode::MissingConfig,
                    message: "config file is missing; using defaults".to_string(),
                    path: Some(config_path),
                }],
            }),
            Err(source) => Err(ConfigStoreError::Io {
                path: config_path,
                source,
            }),
        }
    }

    pub fn from_snapshot(config_path: PathBuf, snapshot: Value) -> Self {
        Self {
            config_path,
            snapshot,
            diagnostics: Vec::new(),
        }
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn snapshot(&self) -> &Value {
        &self.snapshot
    }

    pub fn diagnostics(&self) -> &[ConfigDiagnostic] {
        &self.diagnostics
    }

    pub fn revision(&self) -> String {
        config_revision(&self.snapshot)
    }

    pub fn editor_snapshot(&self) -> ConfigEditorSnapshot {
        let explicit_snapshot = if self.has_missing_config_diagnostic() {
            Value::Object(Map::new())
        } else {
            self.snapshot.clone()
        };
        let explicit_public_config = public_config_snapshot(&explicit_snapshot);
        let effective_public_config = public_config_snapshot(&self.snapshot);
        let origin = if self.has_missing_config_diagnostic() {
            "default"
        } else {
            "file"
        };
        ConfigEditorSnapshot {
            config_path: self.config_path.clone(),
            revision: self.revision(),
            explicit_public_config,
            effective_public_config,
            origins: config_value_origins(&self.snapshot, origin),
            diagnostics: self.diagnostics.clone(),
            secret_presence: config_secret_presence(&explicit_snapshot),
        }
    }

    fn has_missing_config_diagnostic(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == ConfigDiagnosticCode::MissingConfig)
    }

    pub fn save_snapshot(&mut self) -> Result<(), ConfigStoreError> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|source| ConfigStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let contents = serde_json::to_string_pretty(&self.snapshot).map_err(|source| {
            ConfigStoreError::Serialize {
                path: self.config_path.clone(),
                source,
            }
        })?;

        write_atomic_json(&self.config_path, &contents).map_err(|source| ConfigStoreError::Io {
            path: self.config_path.clone(),
            source,
        })
    }

    pub fn apply_operations(
        &mut self,
        request: ConfigOperationRequest,
    ) -> Result<ConfigPatchApplyResult, ConfigStoreError> {
        let latest = ConfigStore::load(self.config_path.clone(), self.snapshot.clone())?;
        let latest_revision = latest.revision();
        if request
            .expected_revision
            .as_deref()
            .is_some_and(|expected| expected != latest_revision)
        {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: public_config_snapshot(latest.snapshot()),
                revision: Some(latest_revision),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some("configuration_changed".to_string()),
            });
        }

        if let Some(conflict) = first_alias_conflict(latest.snapshot()) {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: public_config_snapshot(latest.snapshot()),
                revision: Some(latest_revision),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(format!("alias_conflict: {conflict}")),
            });
        }

        let mut next_snapshot = if latest.has_missing_config_diagnostic() {
            Value::Object(Map::new())
        } else {
            latest.snapshot().clone()
        };
        canonicalize_config_aliases(&mut next_snapshot);
        let mut updated_fields = Vec::new();
        for operation in request.operations {
            match apply_config_operation(&mut next_snapshot, operation) {
                Ok(updated_field) => push_unique(&mut updated_fields, updated_field),
                Err(error) if is_protocol_error(&error) => {
                    return Ok(ConfigPatchApplyResult {
                        ok: false,
                        config: public_config_snapshot(latest.snapshot()),
                        revision: Some(latest_revision.clone()),
                        updated_fields: Vec::new(),
                        side_effects: ConfigPatchSideEffects::default(),
                        error: Some(protocol_error_message(&error)),
                    });
                }
                Err(error) => return Err(error),
            }
        }
        if !next_snapshot.is_object() {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: public_config_snapshot(latest.snapshot()),
                revision: Some(latest_revision),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(
                    "validated config operation result must contain an object config".to_string(),
                ),
            });
        }
        if let Some(error) = validate_config_snapshot(&next_snapshot) {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: public_config_snapshot(latest.snapshot()),
                revision: Some(latest_revision),
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(error),
            });
        }

        self.snapshot = next_snapshot;
        self.save_snapshot()?;

        Ok(ConfigPatchApplyResult {
            ok: true,
            config: public_config_snapshot(&self.snapshot),
            revision: Some(self.revision()),
            updated_fields: updated_fields.clone(),
            side_effects: plan_config_patch_side_effects(&updated_fields),
            error: None,
        })
    }

    pub fn apply_validated_patch_result(
        &mut self,
        result: ConfigPatchBridgeResult,
    ) -> Result<ConfigPatchApplyResult, ConfigStoreError> {
        if !result.ok {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: self.snapshot.clone(),
                revision: None,
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: result.error,
            });
        }
        if !result.config.is_object() {
            return Ok(ConfigPatchApplyResult {
                ok: false,
                config: self.snapshot.clone(),
                revision: None,
                updated_fields: Vec::new(),
                side_effects: ConfigPatchSideEffects::default(),
                error: Some(
                    "validated config patch result must contain an object config".to_string(),
                ),
            });
        }

        self.snapshot = result.config;
        self.save_snapshot()?;

        Ok(ConfigPatchApplyResult {
            ok: true,
            config: self.snapshot.clone(),
            revision: None,
            updated_fields: result.updated_fields,
            side_effects: result.side_effects,
            error: None,
        })
    }

    fn load_from_text(config_path: PathBuf, contents: String, default_snapshot: Value) -> Self {
        let snapshot = match serde_json::from_str::<Value>(&contents) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Self {
                    config_path: config_path.clone(),
                    snapshot: default_snapshot,
                    diagnostics: vec![ConfigDiagnostic {
                        level: ConfigDiagnosticLevel::Warning,
                        code: ConfigDiagnosticCode::InvalidJson,
                        message: format!("failed to parse config JSON: {error}"),
                        path: Some(config_path),
                    }],
                };
            }
        };

        if !snapshot.is_object() {
            return Self {
                config_path: config_path.clone(),
                snapshot: default_snapshot,
                diagnostics: vec![ConfigDiagnostic {
                    level: ConfigDiagnosticLevel::Warning,
                    code: ConfigDiagnosticCode::InvalidConfig,
                    message: "config root must be an object".to_string(),
                    path: Some(config_path),
                }],
            };
        }

        let diagnostics = alias_conflict_diagnostics(&snapshot);

        Self {
            config_path,
            snapshot,
            diagnostics,
        }
    }
}

fn write_atomic_json(path: &Path, contents: &str) -> Result<(), io::Error> {
    let temp_path = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ));
    fs::write(&temp_path, contents)?;
    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(_error) if cfg!(windows) && path.exists() => {
            fs::remove_file(path)?;
            fs::rename(&temp_path, path).map_err(|rename_error| {
                let _ = fs::remove_file(&temp_path);
                rename_error
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

fn config_revision(snapshot: &Value) -> String {
    let bytes = serde_json::to_vec(snapshot).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("hash:{:016x}", hasher.finish())
}

fn apply_config_operation(
    snapshot: &mut Value,
    operation: ConfigOperation,
) -> Result<String, ConfigStoreError> {
    match operation {
        ConfigOperation::Replace { path, value } => {
            reject_masked_secret_placeholder(&path, &value)?;
            set_config_value(snapshot, &path, value)?;
            Ok(canonical_updated_path(&path))
        }
        ConfigOperation::Remove { path } => {
            remove_config_value(snapshot, &path)?;
            Ok(canonical_updated_path(&path))
        }
        ConfigOperation::SecretReplace { path, value } => {
            if !path_segments(&path)
                .iter()
                .any(|segment| is_sensitive_key(segment))
            {
                return Err(config_protocol_error(
                    "secret operation path must target a sensitive field",
                ));
            }
            reject_masked_secret_placeholder(&path, &value)?;
            set_config_value(snapshot, &path, value)?;
            Ok(canonical_updated_path(&path))
        }
        ConfigOperation::SecretRemove { path } => {
            if !path_segments(&path)
                .iter()
                .any(|segment| is_sensitive_key(segment))
            {
                return Err(config_protocol_error(
                    "secret operation path must target a sensitive field",
                ));
            }
            remove_config_value(snapshot, &path)?;
            Ok(canonical_updated_path(&path))
        }
    }
}

fn set_config_value(
    snapshot: &mut Value,
    path: &str,
    value: Value,
) -> Result<(), ConfigStoreError> {
    let segments = canonical_path_segments(&path_segments(path));
    if segments.is_empty() {
        return Err(config_protocol_error("config operation path is empty"));
    }
    let mut current = snapshot;
    for segment in &segments[..segments.len() - 1] {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let object = current
            .as_object_mut()
            .ok_or_else(|| config_protocol_error("config operation parent is not an object"))?;
        current = object
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    current
        .as_object_mut()
        .ok_or_else(|| config_protocol_error("config operation parent is not an object"))?
        .insert(
            segments
                .last()
                .expect("path should have at least one segment")
                .clone(),
            value,
        );
    Ok(())
}

fn remove_config_value(snapshot: &mut Value, path: &str) -> Result<(), ConfigStoreError> {
    let segments = canonical_path_segments(&path_segments(path));
    if segments.is_empty() {
        return Err(config_protocol_error("config operation path is empty"));
    }
    let mut current = snapshot;
    for segment in &segments[..segments.len() - 1] {
        match current.get_mut(segment) {
            Some(next) => current = next,
            None => return Ok(()),
        }
    }
    if let Some(object) = current.as_object_mut() {
        object.remove(
            segments
                .last()
                .expect("path should have at least one segment"),
        );
    }
    Ok(())
}

fn reject_masked_secret_placeholder(path: &str, value: &Value) -> Result<(), ConfigStoreError> {
    if value == "********"
        && path_segments(path)
            .iter()
            .any(|segment| is_sensitive_key(segment))
    {
        return Err(config_protocol_error("masked_secret_placeholder"));
    }
    Ok(())
}

fn path_segments(path: &str) -> Vec<String> {
    if let Some(pointer) = path.strip_prefix('/') {
        return pointer
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
            .collect();
    }
    path.split('.')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn canonical_updated_path(path: &str) -> String {
    canonical_path_segments(&path_segments(path)).join(".")
}

fn canonical_path_segments(segments: &[String]) -> Vec<String> {
    let mut canonical = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        canonical.push(canonical_config_segment(&canonical, index, segment));
    }
    canonical
}

fn canonical_config_segment(parent: &[String], _index: usize, segment: &str) -> String {
    if parent == ["agents", "defaults"] {
        return match segment {
            "active_profile" => "activeProfile".to_string(),
            "max_tokens" => "maxTokens".to_string(),
            "context_block_limit" => "contextBlockLimit".to_string(),
            "max_tool_result_chars" => "maxToolResultChars".to_string(),
            "reasoning_effort" => "reasoningEffort".to_string(),
            other => other.to_string(),
        };
    }
    if parent == ["tools"] && segment == "mcp_servers" {
        return "mcpServers".to_string();
    }
    if parent == ["tools"] && segment == "ssrf_whitelist" {
        return "ssrfWhitelist".to_string();
    }
    if parent == ["channels"] && segment == "send_progress" {
        return "sendProgress".to_string();
    }
    if parent == ["gateway", "heartbeat"] && segment == "interval_s" {
        return "intervalS".to_string();
    }
    if parent == ["knowledge"] {
        return match segment {
            "chunk_size" => "chunkSize".to_string(),
            "chunk_overlap" => "chunkOverlap".to_string(),
            "retrieval_mode" => "retrievalMode".to_string(),
            "graph_extraction_enabled" => "semanticExtractionEnabled".to_string(),
            "graph_extraction_model" => "semanticExtractionModel".to_string(),
            "graph_extraction_max_tokens" => "semanticExtractionMaxTokens".to_string(),
            other => other.to_string(),
        };
    }
    segment.to_string()
}

fn canonicalize_config_aliases(value: &mut Value) {
    canonicalize_config_aliases_at_path(value, &mut Vec::new());
}

fn alias_conflict_diagnostics(snapshot: &Value) -> Vec<ConfigDiagnostic> {
    alias_conflicts(snapshot)
        .into_iter()
        .map(|conflict| ConfigDiagnostic {
            level: ConfigDiagnosticLevel::Warning,
            code: ConfigDiagnosticCode::AliasConflict,
            message: format!("conflicting aliases for canonical config path {conflict}"),
            path: Some(PathBuf::from(conflict)),
        })
        .collect()
}

fn first_alias_conflict(snapshot: &Value) -> Option<String> {
    alias_conflicts(snapshot).into_iter().next()
}

fn alias_conflicts(snapshot: &Value) -> Vec<String> {
    let mut conflicts = Vec::new();
    collect_alias_conflicts(snapshot, &mut Vec::new(), &mut conflicts);
    conflicts
}

fn collect_alias_conflicts(value: &Value, path: &mut Vec<String>, conflicts: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, alias_value) in map {
                let canonical_key = canonical_config_segment(path, path.len(), key);
                if canonical_key != *key {
                    if let Some(canonical_value) = map.get(&canonical_key) {
                        if canonical_value != alias_value {
                            let mut canonical_path = path.clone();
                            canonical_path.push(canonical_key);
                            conflicts.push(canonical_path.join("."));
                        }
                    }
                }
            }
            for (key, child) in map {
                path.push(key.clone());
                collect_alias_conflicts(child, path, conflicts);
                path.pop();
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                path.push(index.to_string());
                collect_alias_conflicts(child, path, conflicts);
                path.pop();
            }
        }
        _ => {}
    }
}

fn canonicalize_config_aliases_at_path(value: &mut Value, path: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let original_keys: Vec<String> = map.keys().cloned().collect();
            for key in original_keys {
                let canonical_key = canonical_config_segment(path, path.len(), &key);
                if canonical_key != key {
                    if let Some(alias_value) = map.remove(&key) {
                        map.entry(canonical_key).or_insert(alias_value);
                    }
                }
            }
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                path.push(key.clone());
                if let Some(child) = map.get_mut(&key) {
                    canonicalize_config_aliases_at_path(child, path);
                }
                path.pop();
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter_mut().enumerate() {
                path.push(index.to_string());
                canonicalize_config_aliases_at_path(child, path);
                path.pop();
            }
        }
        _ => {}
    }
}

fn validate_config_snapshot(snapshot: &Value) -> Option<String> {
    if let Some(port) = snapshot
        .get("gateway")
        .and_then(|gateway| gateway.get("port"))
    {
        let valid_port = port
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port));
        if !valid_port {
            return Some("validation_failed: gateway.port".to_string());
        }
    }
    let chunk_size = snapshot
        .get("knowledge")
        .and_then(|knowledge| knowledge.get("chunkSize"))
        .and_then(Value::as_u64);
    let chunk_overlap = snapshot
        .get("knowledge")
        .and_then(|knowledge| knowledge.get("chunkOverlap"))
        .and_then(Value::as_u64);
    if let (Some(chunk_size), Some(chunk_overlap)) = (chunk_size, chunk_overlap) {
        if chunk_overlap >= chunk_size {
            return Some("validation_failed: knowledge.chunkOverlap".to_string());
        }
    }
    None
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

fn config_value_origins(snapshot: &Value, origin: &str) -> BTreeMap<String, String> {
    let mut origins = BTreeMap::new();
    collect_value_origins(snapshot, &mut Vec::new(), &mut origins, origin);
    origins
}

fn collect_value_origins(
    value: &Value,
    path: &mut Vec<String>,
    origins: &mut BTreeMap<String, String>,
    origin: &str,
) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                path.push(key.clone());
                collect_value_origins(child, path, origins, origin);
                path.pop();
            }
        }
        _ => {
            if !path.is_empty() {
                origins.insert(path.join("."), origin.to_string());
            }
        }
    }
}

fn config_secret_presence(snapshot: &Value) -> BTreeMap<String, Value> {
    let mut presence = BTreeMap::new();
    collect_secret_presence(snapshot, &mut Vec::new(), &mut presence);
    presence
}

fn collect_secret_presence(
    value: &Value,
    path: &mut Vec<String>,
    presence: &mut BTreeMap<String, Value>,
) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                path.push(key.clone());
                if is_sensitive_key(key) {
                    presence.insert(
                        path.join("."),
                        serde_json::json!({
                            "configured": sensitive_value_configured(child),
                            "source": "config"
                        }),
                    );
                } else {
                    collect_secret_presence(child, path, presence);
                }
                path.pop();
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                path.push(index.to_string());
                collect_secret_presence(child, path, presence);
                path.pop();
            }
        }
        _ => {}
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
            | "authorization"
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

fn plan_config_patch_side_effects(updated_fields: &[String]) -> ConfigPatchSideEffects {
    let mut applied = Vec::new();
    let mut restart_required = Vec::new();
    let mut warnings = Vec::new();
    for field in updated_fields {
        if field == "agents.defaults.model"
            || field == "agents.defaults.provider"
            || field == "agents.defaults.activeProfile"
            || field == "agents.defaults.active_profile"
            || field.starts_with("providers.")
        {
            push_unique(&mut applied, "providerRuntimeChanged".to_string());
        }
        if field.starts_with("agents.defaults.embedding.") {
            push_unique(&mut applied, "embeddingConfigChanged".to_string());
        }
        if field.starts_with("tools.mcpServers.") || field.starts_with("tools.mcp_servers.") {
            push_unique(&mut applied, "mcpConfigChanged".to_string());
        }
        if field == "tools.ssrfWhitelist"
            || field.starts_with("tools.ssrfWhitelist.")
            || field == "tools.ssrf_whitelist"
            || field.starts_with("tools.ssrf_whitelist.")
        {
            push_unique(&mut applied, "ssrfWhitelistChanged".to_string());
        }
        if field.starts_with("channels.") {
            push_unique(&mut applied, "channelConfigChanged".to_string());
        }
        if field.starts_with("knowledge.") {
            push_unique(&mut applied, "knowledgeConfigChanged".to_string());
        }
        if field == "agents.defaults.workspace" {
            push_unique(&mut restart_required, "workspaceReloadRequired".to_string());
            push_unique(
                &mut warnings,
                "agents.defaults.workspace requires an explicit workspace reload".to_string(),
            );
        }
        if field == "gateway.host" || field == "gateway.port" {
            push_unique(&mut restart_required, "gatewayRestartRequired".to_string());
            push_unique(
                &mut warnings,
                "gateway host or port changes require restart".to_string(),
            );
        }
    }
    ConfigPatchSideEffects {
        applied,
        restart_required,
        warnings,
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn config_protocol_error(message: &str) -> ConfigStoreError {
    ConfigStoreError::Io {
        path: PathBuf::from(message),
        source: io::Error::new(io::ErrorKind::InvalidInput, message.to_string()),
    }
}

fn is_protocol_error(error: &ConfigStoreError) -> bool {
    matches!(
        error,
        ConfigStoreError::Io { source, .. } if source.kind() == io::ErrorKind::InvalidInput
    )
}

fn protocol_error_message(error: &ConfigStoreError) -> String {
    match error {
        ConfigStoreError::Io { source, .. } => source.to_string(),
        other => other.to_string(),
    }
}

impl fmt::Display for ConfigStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigStoreError::Io { path, source } => {
                write!(formatter, "failed to access {}: {source}", path.display())
            }
            ConfigStoreError::Serialize { path, source } => {
                write!(
                    formatter,
                    "failed to serialize config {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for ConfigStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            ConfigStoreError::Io { source, .. } => Some(source),
            ConfigStoreError::Serialize { source, .. } => Some(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn load_missing_config_returns_default_snapshot_with_diagnostic() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("missing/config.json");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("missing config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(
            store.diagnostics(),
            &[ConfigDiagnostic {
                level: ConfigDiagnosticLevel::Info,
                code: ConfigDiagnosticCode::MissingConfig,
                message: "config file is missing; using defaults".to_string(),
                path: Some(path),
            }]
        );
    }

    #[test]
    fn load_invalid_json_returns_default_snapshot_with_warning() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", "{ invalid json");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("invalid config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(store.diagnostics()[0].level, ConfigDiagnosticLevel::Warning);
        assert_eq!(
            store.diagnostics()[0].code,
            ConfigDiagnosticCode::InvalidJson
        );
        assert_eq!(store.diagnostics()[0].path, Some(path));
        assert!(store.diagnostics()[0]
            .message
            .contains("failed to parse config JSON"));
    }

    #[test]
    fn load_non_object_json_returns_default_snapshot_with_warning() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", "[]");

        let store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("non-object config should fall back to defaults");

        assert_eq!(store.snapshot(), &default_snapshot());
        assert_eq!(store.diagnostics()[0].level, ConfigDiagnosticLevel::Warning);
        assert_eq!(
            store.diagnostics()[0].code,
            ConfigDiagnosticCode::InvalidConfig
        );
        assert_eq!(
            store.diagnostics()[0].message,
            "config root must be an object"
        );
        assert_eq!(store.diagnostics()[0].path, Some(path));
    }

    #[test]
    fn load_valid_config_uses_file_snapshot_without_diagnostics() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#,
        );

        let store = ConfigStore::load(path, default_snapshot())
            .expect("valid config should load file snapshot");

        assert_eq!(store.snapshot()["agents"]["defaults"]["model"], "gpt-5");
        assert!(store.diagnostics().is_empty());
    }

    #[test]
    fn save_snapshot_creates_parent_and_writes_pretty_json() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("nested/config.json");
        let mut store = ConfigStore::from_snapshot(
            path.clone(),
            json!({"tools":{"restrictToWorkspace":false}}),
        );

        store
            .save_snapshot()
            .expect("save should create parent dirs and write json");

        let saved = fs::read_to_string(path).expect("saved config should exist");
        assert!(saved.contains("\n  \"tools\": {"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved).expect("saved config should be JSON"),
            json!({"tools":{"restrictToWorkspace":false}})
        );
    }

    #[test]
    fn apply_validated_patch_result_updates_snapshot_and_saves_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("config.json");
        let mut store = ConfigStore::from_snapshot(path.clone(), default_snapshot());

        let result = store
            .apply_validated_patch_result(ConfigPatchBridgeResult {
                ok: true,
                config: json!({"agents":{"defaults":{"model":"gpt-5","provider":"openai"}}}),
                updated_fields: vec![
                    "agents.defaults.model".to_string(),
                    "agents.defaults.provider".to_string(),
                ],
                side_effects: ConfigPatchSideEffects {
                    applied: vec!["providerRuntimeChanged".to_string()],
                    restart_required: vec![],
                    warnings: vec![],
                },
                error: None,
            })
            .expect("validated patch should save");

        assert!(result.ok);
        assert_eq!(
            result.updated_fields,
            vec!["agents.defaults.model", "agents.defaults.provider"]
        );
        assert_eq!(result.side_effects.applied, vec!["providerRuntimeChanged"]);
        assert_eq!(store.snapshot()["agents"]["defaults"]["model"], "gpt-5");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(path).expect("patched config should save")
            )
            .expect("patched config should be JSON"),
            json!({"agents":{"defaults":{"model":"gpt-5","provider":"openai"}}})
        );
    }

    #[test]
    fn apply_failed_patch_result_preserves_snapshot_and_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("config.json");
        let original = default_snapshot();
        let mut store = ConfigStore::from_snapshot(path.clone(), original.clone());
        store
            .save_snapshot()
            .expect("fixture config should save before failed patch");

        let result = store
            .apply_validated_patch_result(ConfigPatchBridgeResult {
                ok: false,
                config: json!({"agents":{"defaults":{"model":" "}}}),
                updated_fields: vec!["agents.defaults.model".to_string()],
                side_effects: ConfigPatchSideEffects::default(),
                error: Some("agents.defaults.model must not be empty".to_string()),
            })
            .expect("failed patch result should not be an IO error");

        assert!(!result.ok);
        assert_eq!(
            result.error,
            Some("agents.defaults.model must not be empty".to_string())
        );
        assert_eq!(store.snapshot(), &original);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(path).expect("original config should still exist")
            )
            .expect("original config should be JSON"),
            original
        );
    }

    #[test]
    fn editor_snapshot_exposes_revision_and_redacted_public_config() {
        let path = PathBuf::from("config.json");
        let store = ConfigStore::from_snapshot(
            path.clone(),
            json!({
                "agents": {
                    "defaults": {
                        "model": "gpt-5",
                        "timezone": "UTC"
                    }
                },
                "providers": {
                    "openai": {
                        "provider": "openai",
                        "api_key": "sk-secret",
                        "api_base": "https://api.openai.com/v1"
                    }
                }
            }),
        );

        let snapshot = store.editor_snapshot();

        assert_eq!(snapshot.config_path, path);
        assert_eq!(snapshot.revision, store.revision());
        assert_eq!(
            snapshot.explicit_public_config["providers"]["openai"]["api_key_configured"],
            json!(true)
        );
        assert!(snapshot.explicit_public_config["providers"]["openai"]
            .get("api_key")
            .is_none());
        assert_eq!(
            snapshot.secret_presence["providers.openai.api_key"],
            json!({
                "configured": true,
                "source": "config"
            })
        );
    }

    #[test]
    fn editor_snapshot_keeps_missing_file_defaults_out_of_explicit_config() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("missing/config.json");
        let store = ConfigStore::load(path, default_snapshot())
            .expect("missing config should load defaults for effective view");

        let snapshot = store.editor_snapshot();

        assert_eq!(snapshot.explicit_public_config, json!({}));
        assert_eq!(
            snapshot.effective_public_config["agents"]["defaults"]["model"],
            "deepseek-reasoner"
        );
        assert_eq!(snapshot.origins["agents.defaults.model"], "default");
    }

    #[test]
    fn apply_operations_preserves_unrelated_raw_secrets() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{
              "agents": { "defaults": { "model": "gpt-5", "timezone": "UTC" } },
              "providers": {
                "openai": {
                  "provider": "openai",
                  "api_key": "sk-secret",
                  "api_base": "https://api.openai.com/v1"
                }
              }
            }"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Replace {
                    path: "agents.defaults.timezone".to_string(),
                    value: json!("Asia/Shanghai"),
                }],
            })
            .expect("operation patch should save");

        assert!(result.ok);
        assert_eq!(result.updated_fields, vec!["agents.defaults.timezone"]);
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("patched config should save"),
        )
        .expect("patched config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
        assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
        assert!(result.config["providers"]["openai"]
            .get("api_key")
            .is_none());
        assert_eq!(
            result.config["providers"]["openai"]["api_key_configured"],
            json!(true)
        );
    }

    #[test]
    fn apply_operations_to_missing_config_does_not_materialize_defaults() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.path("missing/config.json");
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("missing config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Replace {
                    path: "agents.defaults.timezone".to_string(),
                    value: json!("Asia/Shanghai"),
                }],
            })
            .expect("operation save should create config");

        assert!(result.ok);
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("config should save"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["timezone"], "Asia/Shanghai");
        assert!(saved["agents"]["defaults"].get("model").is_none());
    }

    #[test]
    fn apply_operations_remove_deletes_target_without_empty_object_merge() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{
              "tools": {
                "mcpServers": {
                  "docs": { "command": "docs-mcp" },
                  "search": { "command": "search-mcp" }
                }
              }
            }"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Remove {
                    path: "tools.mcpServers.docs".to_string(),
                }],
            })
            .expect("remove operation should save");

        assert!(result.ok);
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("patched config should save"),
        )
        .expect("patched config should be JSON");
        assert!(saved["tools"]["mcpServers"].get("docs").is_none());
        assert_eq!(
            saved["tools"]["mcpServers"]["search"]["command"],
            "search-mcp"
        );
    }

    #[test]
    fn apply_operations_rejects_stale_revision_and_preserves_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"model":"gpt-5"}}}"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");
        fs::write(
            &path,
            r#"{"agents":{"defaults":{"model":"externally-edited"}}}"#,
        )
        .expect("external edit should write");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some("stale-revision".to_string()),
                operations: vec![ConfigOperation::Replace {
                    path: "agents.defaults.model".to_string(),
                    value: json!("gpt-5.1"),
                }],
            })
            .expect("revision conflict should be a protocol result");

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("configuration_changed"));
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("externally edited config should remain"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["model"], "externally-edited");
    }

    #[test]
    fn apply_operations_rejects_masked_secret_placeholder() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"providers":{"openai":{"api_key":"sk-secret"}}}"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::SecretReplace {
                    path: "providers.openai.api_key".to_string(),
                    value: json!("********"),
                }],
            })
            .expect("masked placeholder should be rejected as a protocol result");

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("masked_secret_placeholder"));
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("original config should remain"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["providers"]["openai"]["api_key"], "sk-secret");
    }

    #[test]
    fn apply_operations_writes_canonical_key_for_legacy_alias_path() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"maxTokens":2048,"max_tokens":2048}}}"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Replace {
                    path: "agents.defaults.max_tokens".to_string(),
                    value: json!(8192),
                }],
            })
            .expect("alias operation should save");

        assert!(result.ok);
        assert_eq!(result.updated_fields, vec!["agents.defaults.maxTokens"]);
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("patched config should save"),
        )
        .expect("patched config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["maxTokens"], 8192);
        assert!(saved["agents"]["defaults"].get("max_tokens").is_none());
    }

    #[test]
    fn load_reports_conflicting_alias_diagnostics() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"maxTokens":4096,"max_tokens":2048}}}"#,
        );

        let store = ConfigStore::load(path, default_snapshot())
            .expect("conflicting aliases should still load for diagnostics");

        assert_eq!(
            store.diagnostics()[0].code,
            ConfigDiagnosticCode::AliasConflict
        );
        assert!(store.diagnostics()[0]
            .message
            .contains("agents.defaults.maxTokens"));
    }

    #[test]
    fn apply_operations_rejects_conflicting_aliases_without_writing() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write(
            "config.json",
            r#"{"agents":{"defaults":{"maxTokens":4096,"max_tokens":2048}}}"#,
        );
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Replace {
                    path: "agents.defaults.maxTokens".to_string(),
                    value: json!(8192),
                }],
            })
            .expect("alias conflict should be a protocol result");

        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("alias_conflict: agents.defaults.maxTokens")
        );
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("original config should remain"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["agents"]["defaults"]["maxTokens"], 4096);
        assert_eq!(saved["agents"]["defaults"]["max_tokens"], 2048);
    }

    #[test]
    fn apply_operations_rejects_invalid_gateway_port_without_writing() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", r#"{"gateway":{"port":18790}}"#);
        let mut store = ConfigStore::load(path.clone(), default_snapshot())
            .expect("fixture config should load");

        let result = store
            .apply_operations(ConfigOperationRequest {
                expected_revision: Some(store.revision()),
                operations: vec![ConfigOperation::Replace {
                    path: "gateway.port".to_string(),
                    value: json!(70000),
                }],
            })
            .expect("validation failure should be a protocol result");

        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("validation_failed: gateway.port")
        );
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("original config should remain"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["gateway"]["port"], 18790);
    }

    #[test]
    fn save_snapshot_reports_atomic_write_failure_without_changing_authoritative_file() {
        let fixture = ConfigStoreFixture::new();
        let path = fixture.write("config.json", r#"{"gateway":{"port":18790}}"#);
        let blocking_temp_path = path.with_extension("json.tmp");
        fs::create_dir_all(&blocking_temp_path).expect("blocking temp directory should create");
        let mut store = ConfigStore::from_snapshot(path.clone(), json!({"gateway":{"port":18888}}));

        let error = store
            .save_snapshot()
            .expect_err("temp-file creation failure should be reported");

        match error {
            ConfigStoreError::Io {
                path: error_path, ..
            } => assert_eq!(error_path, path),
            other => panic!("expected IO error, got {other:?}"),
        }
        let saved = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(path).expect("authoritative config should remain"),
        )
        .expect("saved config should be JSON");
        assert_eq!(saved["gateway"]["port"], 18790);
    }

    fn default_snapshot() -> serde_json::Value {
        json!({
            "agents": {
                "defaults": {
                    "model": "deepseek-reasoner"
                }
            }
        })
    }

    struct ConfigStoreFixture {
        root: PathBuf,
    }

    impl ConfigStoreFixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let root = std::env::temp_dir().join(format!("tinybot-config-store-test-{nonce}"));
            fs::create_dir_all(&root).expect("fixture root should create");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.path(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("fixture parent should create");
            }
            fs::write(&path, contents).expect("fixture file should write");
            path
        }
    }

    impl Drop for ConfigStoreFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
