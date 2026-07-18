use super::*;
use crate::worker_storage::replace_file;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

const TEMPORARY_FILE_RESOURCE_VERSION: u32 = 1;
const TEMPORARY_FILE_RESOURCE_PATH: &str = ".tinybot/resources/session-temporary-files.json";

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryFileResourceStore {
    #[serde(default = "temporary_file_resource_version")]
    version: u32,
    #[serde(default)]
    files_by_session: BTreeMap<String, Vec<Value>>,
}

impl WorkerSessionRpc {
    pub fn new(sessions: Vec<SessionMetadata>, policy: CapabilityPolicy) -> Self {
        Self {
            sessions,
            policy,
            resource_path: None,
        }
    }

    pub fn new_persistent_resources(
        root: PathBuf,
        sessions: Vec<SessionMetadata>,
        policy: CapabilityPolicy,
    ) -> Result<Self, WorkerProtocolError> {
        let resource_path = root.join(TEMPORARY_FILE_RESOURCE_PATH);
        let mut rpc = Self {
            sessions,
            policy,
            resource_path: Some(resource_path.clone()),
        };
        let Some(store) = read_resource_store(&resource_path)? else {
            return Ok(rpc);
        };
        if store.version != TEMPORARY_FILE_RESOURCE_VERSION {
            return Err(resource_error(
                "temporary file resource sidecar version is unsupported",
                serde_json::json!({
                    "path": resource_path,
                    "expectedVersion": TEMPORARY_FILE_RESOURCE_VERSION,
                    "actualVersion": store.version,
                }),
            ));
        }
        for (session_id, files) in store.files_by_session {
            let session = rpc.session_mut_or_create(&session_id);
            ensure_extra_object(session);
            session.extra["temporary_files"] = Value::Array(files);
        }
        Ok(rpc)
    }

    pub(super) fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
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

    pub(super) fn session_mut_or_create(&mut self, session_id: &str) -> &mut SessionMetadata {
        if let Some(index) = self
            .sessions
            .iter()
            .position(|session| session.session_id == session_id)
        {
            return &mut self.sessions[index];
        }
        let timestamp = now_session_timestamp();
        self.sessions.push(SessionMetadata {
            session_id: session_id.to_string(),
            title: format!("Desktop Session {session_id}"),
            workspace_dir: String::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
            extra: serde_json::json!({}),
        });
        self.sessions
            .last_mut()
            .expect("newly pushed session should be present")
    }

    pub(super) fn persist_temporary_file_resources(&self) -> Result<(), WorkerProtocolError> {
        let Some(resource_path) = &self.resource_path else {
            return Ok(());
        };
        let files_by_session = self
            .sessions
            .iter()
            .filter_map(|session| {
                let files = session
                    .extra
                    .get("temporary_files")
                    .and_then(Value::as_array)
                    .filter(|files| !files.is_empty())?
                    .clone();
                Some((session.session_id.clone(), files))
            })
            .collect();
        write_resource_store(
            resource_path,
            &TemporaryFileResourceStore {
                version: TEMPORARY_FILE_RESOURCE_VERSION,
                files_by_session,
            },
        )
    }
}

pub(super) fn validate_session_id(session_id: &str) -> Result<(), WorkerProtocolError> {
    if session_id.is_empty()
        || session_id.contains('\0')
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "invalid session id",
            serde_json::json!({ "session_id": session_id }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ));
    }
    Ok(())
}

pub(super) fn unknown_session_error(session_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "session metadata not found",
        serde_json::json!({ "session_id": session_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn ensure_extra_object(session: &mut SessionMetadata) {
    if !session.extra.is_object() {
        session.extra = serde_json::json!({});
    }
}

pub(super) fn now_session_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis}")
}

pub(super) fn temporary_chunk_count(content: &str) -> usize {
    let len = content.chars().count();
    if len == 0 {
        0
    } else {
        len.div_ceil(900)
    }
}

pub(super) fn stable_upload_digest(
    session_id: &str,
    name: &str,
    timestamp: &str,
    content: &str,
) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session_id.hash(&mut hasher);
    name.hash(&mut hasher);
    timestamp.hash(&mut hasher);
    content
        .chars()
        .take(200)
        .collect::<String>()
        .hash(&mut hasher);
    format!("{:010x}", hasher.finish())[..10].to_string()
}

fn temporary_file_resource_version() -> u32 {
    TEMPORARY_FILE_RESOURCE_VERSION
}

fn read_resource_store(
    path: &std::path::Path,
) -> Result<Option<TemporaryFileResourceStore>, WorkerProtocolError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| {
        resource_error(
            "failed to read temporary file resource sidecar",
            serde_json::json!({ "path": path, "error": error.to_string() }),
        )
    })?;
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        resource_error(
            "temporary file resource sidecar is invalid",
            serde_json::json!({ "path": path, "error": error.to_string() }),
        )
    })
}

fn write_resource_store(
    path: &std::path::Path,
    store: &TemporaryFileResourceStore,
) -> Result<(), WorkerProtocolError> {
    let parent = path.parent().ok_or_else(|| {
        resource_error(
            "temporary file resource sidecar has no parent directory",
            serde_json::json!({ "path": path }),
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        resource_error(
            "failed to create temporary file resource directory",
            serde_json::json!({ "path": path, "error": error.to_string() }),
        )
    })?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| {
        resource_error(
            "failed to serialize temporary file resource sidecar",
            serde_json::json!({ "path": path, "error": error.to_string() }),
        )
    })?;
    let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&temp_path).map_err(|error| {
        resource_error(
            "failed to create temporary file resource sidecar",
            serde_json::json!({
                "path": path,
                "tempPath": temp_path,
                "error": error.to_string(),
            }),
        )
    })?;
    file.write_all(&bytes).map_err(|error| {
        resource_error(
            "failed to write temporary file resource sidecar",
            serde_json::json!({
                "path": path,
                "tempPath": temp_path,
                "error": error.to_string(),
            }),
        )
    })?;
    file.sync_all().map_err(|error| {
        resource_error(
            "failed to sync temporary file resource sidecar",
            serde_json::json!({
                "path": path,
                "tempPath": temp_path,
                "error": error.to_string(),
            }),
        )
    })?;
    replace_file(&temp_path, path).map_err(|error| {
        resource_error(
            "failed to publish temporary file resource sidecar",
            serde_json::json!({
                "path": path,
                "tempPath": temp_path,
                "error": error.to_string(),
            }),
        )
    })
}

fn resource_error(message: &str, details: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn temporary_file_resources_survive_restart_in_dedicated_sidecar() {
        let root = test_root();
        let policy = CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]);
        let mut rpc =
            WorkerSessionRpc::new_persistent_resources(root.clone(), Vec::new(), policy.clone())
                .expect("resource store should initialize");

        rpc.upload_temporary_file("websocket:sidecar", "notes.md", "md", "hello", 5)
            .expect("temporary file should persist");

        let restarted =
            WorkerSessionRpc::new_persistent_resources(root.clone(), Vec::new(), policy)
                .expect("resource store should reopen");
        let listed = restarted
            .list_temporary_files("websocket:sidecar")
            .expect("temporary files should list after restart");
        assert_eq!(listed["temporary_files"][0]["content"], "hello");
        assert!(root.join(TEMPORARY_FILE_RESOURCE_PATH).is_file());
        std::fs::remove_dir_all(root).expect("test root should clean up");
    }

    fn test_root() -> PathBuf {
        let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tinybot-session-resources-{}-{unique}",
            std::process::id()
        ))
    }
}
