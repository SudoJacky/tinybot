use super::*;
use crate::storage::atomic::{
    write_bytes_atomic_checked, write_json_pretty_atomic, AtomicWriteOptions, WorkerStorageError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{fs, io, sync::Mutex};

const MAX_REVIEW_BYTES: u64 = 25 * 1024 * 1024;
static REVIEW_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ReviewAction {
    Prepare {
        expected_revision: String,
        request_id: String,
    },
    Status,
    Compare {
        expected_revision: String,
    },
    Accept {
        review_id: String,
        expected_hash: String,
    },
    Restore {
        review_id: String,
        expected_hash: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewState {
    Pending,
    Accepted,
    Restored,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactReview {
    pub id: String,
    pub path: String,
    pub thread_id: String,
    pub request_id: String,
    pub base_hash: String,
    pub created_at_ms: i64,
    pub state: ReviewState,
}

impl WorkerWorkspaceRpc {
    // A review records the live file before a referenced request is dispatched.
    // Pending requests share that baseline until the user keeps or restores it.
    pub(crate) fn artifact_review(
        &self,
        data_root: &Path,
        thread_id: &str,
        path: &str,
        action: ReviewAction,
    ) -> Result<serde_json::Value, String> {
        let _guard = REVIEW_LOCK
            .lock()
            .map_err(|_| "artifact review lock poisoned")?;
        let resolved = self.resolve_path(path).map_err(review_error)?;
        ensure_inside_workspace(&self.root, &resolved.absolute_path).map_err(review_error)?;
        let workspace = self
            .root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let key = hash(
            &serde_json::to_vec(&(workspace, thread_id, &resolved.relative_path))
                .map_err(|error| error.to_string())?,
        );
        let directory = data_root.join("artifact-reviews").join(key);
        let manifest = directory.join("review.json");
        ensure_write_target_inside_workspace(data_root, &manifest).map_err(review_error)?;
        let mut review = match fs::read(&manifest) {
            Ok(bytes) => Some(
                serde_json::from_slice::<ArtifactReview>(&bytes)
                    .map_err(|error| format!("Invalid artifact review: {error}"))?,
            ),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Cannot read artifact review: {error}")),
        };
        if let Some(saved) = &review {
            if saved.path != resolved.relative_path
                || saved.thread_id != thread_id
                || !is_hash(&saved.base_hash)
            {
                return Err("Artifact review identity does not match its file".into());
            }
        }
        match action {
            ReviewAction::Status => {
                return serde_json::to_value(review).map_err(|error| error.to_string())
            }
            ReviewAction::Prepare {
                expected_revision,
                request_id,
            } => {
                if expected_revision.is_empty() || request_id.is_empty() {
                    return Err("Artifact review requires a viewed revision and request ID".into());
                }
                let bytes = self
                    .read_file_bytes(path, Some(&expected_revision), MAX_REVIEW_BYTES)
                    .map_err(review_error)?;
                if let Some(saved) = &review {
                    if saved.state == ReviewState::Pending {
                        return serde_json::to_value(saved).map_err(|error| error.to_string());
                    }
                }
                let base_hash = hash(&bytes);
                fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
                ensure_inside_workspace(data_root, &directory).map_err(review_error)?;
                let snapshot = directory.join(format!("{base_hash}.bin"));
                write_bytes_atomic_checked(
                    &snapshot,
                    &bytes,
                    AtomicWriteOptions::default(),
                    || Ok(()),
                )
                .map_err(|error| error.to_string())?;
                review = Some(ArtifactReview {
                    id: hash(format!("{thread_id}:{request_id}:{base_hash}").as_bytes()),
                    path: resolved.relative_path,
                    thread_id: thread_id.into(),
                    request_id,
                    base_hash,
                    created_at_ms: chrono::Utc::now().timestamp_millis(),
                    state: ReviewState::Pending,
                });
            }
            ReviewAction::Compare { expected_revision } => {
                let saved = review
                    .as_ref()
                    .ok_or("No saved version is available for this file")?;
                let before = read_snapshot(&directory, &saved.base_hash)?;
                let after = self
                    .read_file_bytes(path, Some(&expected_revision), MAX_REVIEW_BYTES)
                    .map_err(review_error)?;
                return Ok(serde_json::json!({
                    "review": saved,
                    "beforeBase64": STANDARD.encode(&before),
                    "afterBase64": STANDARD.encode(&after),
                    "currentHash": hash(&after),
                    "changed": before != after,
                }));
            }
            ReviewAction::Accept {
                review_id,
                expected_hash,
            } => {
                let saved = pending_review(&mut review, &review_id)?;
                let current = self
                    .read_file_bytes(path, None, MAX_REVIEW_BYTES)
                    .map_err(review_error)?;
                verify_hash(&current, &expected_hash)?;
                saved.state = ReviewState::Accepted;
            }
            ReviewAction::Restore {
                review_id,
                expected_hash,
            } => {
                self.require(WorkerCapability::FsWorkspaceWrite)
                    .map_err(review_error)?;
                let saved = pending_review(&mut review, &review_id)?;
                let before = read_snapshot(&directory, &saved.base_hash)?;
                let current = self
                    .read_file_bytes(path, None, MAX_REVIEW_BYTES)
                    .map_err(review_error)?;
                verify_hash(&current, &expected_hash)?;
                ensure_write_target_inside_workspace(&self.root, &resolved.absolute_path)
                    .map_err(review_error)?;
                write_bytes_atomic_checked(
                    &resolved.absolute_path,
                    &before,
                    AtomicWriteOptions::default().preserve_target_permissions(),
                    || {
                        let verify = || -> Result<(), String> {
                            ensure_write_target_inside_workspace(
                                &self.root,
                                &resolved.absolute_path,
                            )
                            .map_err(review_error)?;
                            let latest = self
                                .read_file_bytes(path, None, MAX_REVIEW_BYTES)
                                .map_err(review_error)?;
                            verify_hash(&latest, &expected_hash)
                        };
                        verify().map_err(|message| WorkerStorageError::Io {
                            operation: "restore artifact",
                            path: resolved.absolute_path.clone(),
                            source: io::Error::other(message),
                        })
                    },
                )
                .map_err(|error| error.to_string())?;
                saved.state = ReviewState::Restored;
            }
        }
        write_json_pretty_atomic(&manifest, &review, AtomicWriteOptions::default()).map_err(|error| {
            if review.as_ref().is_some_and(|saved| saved.state == ReviewState::Restored) {
                format!("The file was restored, but its review state could not be recorded: {error}")
            } else {
                format!("Could not record artifact review state: {error}")
            }
        })?;
        serde_json::to_value(review).map_err(|error| error.to_string())
    }
}

fn pending_review<'a>(
    review: &'a mut Option<ArtifactReview>,
    id: &str,
) -> Result<&'a mut ArtifactReview, String> {
    let saved = review
        .as_mut()
        .ok_or("No saved version is available for this file")?;
    if saved.id != id || saved.state != ReviewState::Pending {
        return Err("Artifact review changed; reopen the comparison".into());
    }
    Ok(saved)
}

fn read_snapshot(directory: &Path, expected_hash: &str) -> Result<Vec<u8>, String> {
    let path = directory.join(format!("{expected_hash}.bin"));
    ensure_inside_workspace(directory, &path).map_err(review_error)?;
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_REVIEW_BYTES {
        return Err("Saved artifact exceeds the review limit".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Cannot read saved artifact: {error}"))?;
    if hash(&bytes) != expected_hash {
        return Err("Saved artifact checksum does not match; restoration is unavailable".into());
    }
    Ok(bytes)
}

fn verify_hash(bytes: &[u8], expected: &str) -> Result<(), String> {
    if hash(bytes) != expected {
        return Err("artifact_review_conflict: The file changed after comparison. Compare again before keeping or restoring it.".into());
    }
    Ok(())
}
fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn review_error(error: WorkerProtocolError) -> String {
    format!("{}; details={}", error.message, error.details)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (TestRoot, WorkerWorkspaceRpc, PathBuf) {
        let unique = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = TestRoot(std::env::temp_dir().join(format!(
            "tinybot-artifact-review-{}-{unique}",
            std::process::id()
        )));
        let workspace = temp.0.join("workspace");
        let data = temp.0.join("data");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(workspace.join("report.xlsx"), b"original\0workbook").unwrap();
        let rpc = WorkerWorkspaceRpc::new(
            workspace,
            crate::protocol::capability::default_desktop_capability_policy(),
        );
        (temp, rpc, data)
    }
    fn prepare(rpc: &WorkerWorkspaceRpc, data: &Path) -> serde_json::Value {
        let revision = rpc
            .read_file_chunk("report.xlsx", None, None)
            .unwrap()
            .revision;
        rpc.artifact_review(
            data,
            "thread-1",
            "report.xlsx",
            ReviewAction::Prepare {
                expected_revision: revision,
                request_id: "request-1".into(),
            },
        )
        .unwrap()
    }
    fn compare(rpc: &WorkerWorkspaceRpc, data: &Path) -> serde_json::Value {
        let revision = rpc
            .read_file_chunk("report.xlsx", None, None)
            .unwrap()
            .revision;
        rpc.artifact_review(
            data,
            "thread-1",
            "report.xlsx",
            ReviewAction::Compare {
                expected_revision: revision,
            },
        )
        .unwrap()
    }
    #[test]
    fn artifact_review_accepts_current_bytes_and_starts_a_new_baseline() {
        let (_temp, rpc, data) = fixture();
        let original = prepare(&rpc, &data);
        fs::write(rpc.root.join("report.xlsx"), b"accepted workbook").unwrap();
        let comparison = compare(&rpc, &data);
        let accepted = rpc
            .artifact_review(
                &data,
                "thread-1",
                "report.xlsx",
                ReviewAction::Accept {
                    review_id: original["id"].as_str().unwrap().into(),
                    expected_hash: comparison["currentHash"].as_str().unwrap().into(),
                },
            )
            .unwrap();
        assert_eq!(accepted["state"], "accepted");
        assert_eq!(
            fs::read(rpc.root.join("report.xlsx")).unwrap(),
            b"accepted workbook"
        );
        let next = prepare(&rpc, &data);
        assert_ne!(next["baseHash"], original["baseHash"]);
        assert_eq!(next["baseHash"], comparison["currentHash"]);
    }
    #[test]
    fn artifact_review_detects_corrupt_snapshots_before_restoring() {
        let (_temp, rpc, data) = fixture();
        let original = prepare(&rpc, &data);
        let comparison = compare(&rpc, &data);
        let directory = fs::read_dir(data.join("artifact-reviews"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(
            directory.join(format!("{}.bin", original["baseHash"].as_str().unwrap())),
            b"corrupt",
        )
        .unwrap();
        let result = rpc.artifact_review(
            &data,
            "thread-1",
            "report.xlsx",
            ReviewAction::Restore {
                review_id: original["id"].as_str().unwrap().into(),
                expected_hash: comparison["currentHash"].as_str().unwrap().into(),
            },
        );
        assert!(result.unwrap_err().contains("checksum"));
        assert_eq!(
            fs::read(rpc.root.join("report.xlsx")).unwrap(),
            b"original\0workbook"
        );
    }
    #[test]
    fn artifact_review_preserves_exact_bytes_and_survives_reopening() {
        let (_temp, rpc, data) = fixture();
        let review = prepare(&rpc, &data);
        fs::write(rpc.root.join("report.xlsx"), b"modified\0workbook").unwrap();
        let comparison = compare(&rpc, &data);
        assert_eq!(comparison["changed"], true);
        assert_eq!(
            STANDARD
                .decode(comparison["beforeBase64"].as_str().unwrap())
                .unwrap(),
            b"original\0workbook"
        );
        let reopened = WorkerWorkspaceRpc::new(
            rpc.root.clone(),
            crate::protocol::capability::default_desktop_capability_policy(),
        );
        let result = reopened
            .artifact_review(
                &data,
                "thread-1",
                "report.xlsx",
                ReviewAction::Restore {
                    review_id: review["id"].as_str().unwrap().into(),
                    expected_hash: comparison["currentHash"].as_str().unwrap().into(),
                },
            )
            .unwrap();
        assert_eq!(result["state"], "restored");
        assert_eq!(
            fs::read(rpc.root.join("report.xlsx")).unwrap(),
            b"original\0workbook"
        );
    }
    #[test]
    fn artifact_review_rejects_later_external_changes_for_both_actions() {
        let (_temp, rpc, data) = fixture();
        let review = prepare(&rpc, &data);
        let comparison = compare(&rpc, &data);
        fs::write(rpc.root.join("report.xlsx"), b"external edit").unwrap();
        for action in [
            ReviewAction::Accept {
                review_id: review["id"].as_str().unwrap().into(),
                expected_hash: comparison["currentHash"].as_str().unwrap().into(),
            },
            ReviewAction::Restore {
                review_id: review["id"].as_str().unwrap().into(),
                expected_hash: comparison["currentHash"].as_str().unwrap().into(),
            },
        ] {
            assert!(rpc
                .artifact_review(&data, "thread-1", "report.xlsx", action)
                .unwrap_err()
                .contains("artifact_review_conflict"));
        }
        assert_eq!(
            fs::read(rpc.root.join("report.xlsx")).unwrap(),
            b"external edit"
        );
    }
    #[test]
    fn artifact_review_keeps_pending_baseline_and_enforces_thread_scope() {
        let (_temp, rpc, data) = fixture();
        let first = prepare(&rpc, &data);
        fs::write(rpc.root.join("report.xlsx"), b"second draft").unwrap();
        assert_eq!(prepare(&rpc, &data)["baseHash"], first["baseHash"]);
        assert_eq!(
            rpc.artifact_review(&data, "other-thread", "report.xlsx", ReviewAction::Status)
                .unwrap(),
            serde_json::Value::Null
        );
        assert!(rpc
            .artifact_review(&data, "thread-1", "../outside.xlsx", ReviewAction::Status)
            .is_err());
        assert!(rpc
            .artifact_review(
                &data,
                "thread-1",
                "report.xlsx",
                ReviewAction::Prepare {
                    expected_revision: "stale".into(),
                    request_id: "request-2".into()
                }
            )
            .is_err());
    }
}
