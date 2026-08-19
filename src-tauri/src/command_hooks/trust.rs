use crate::storage::atomic::{read_json_store, write_json_pretty_atomic, AtomicWriteOptions};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::config::load_resolved_hooks;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookTrustFile {
    #[serde(default = "trust_schema_version")]
    schema_version: u32,
    #[serde(default)]
    trusted_hashes: BTreeSet<String>,
}

impl Default for HookTrustFile {
    fn default() -> Self {
        Self {
            schema_version: trust_schema_version(),
            trusted_hashes: BTreeSet::new(),
        }
    }
}

fn trust_schema_version() -> u32 {
    1
}

pub(super) struct HookTrustStore {
    path: PathBuf,
    file: HookTrustFile,
}

impl HookTrustStore {
    pub(super) fn load(data_root: &Path) -> Result<Self, String> {
        let path = data_root.join("hook-trust.json");
        let file = read_json_store::<HookTrustFile>(&path)
            .map_err(|error| format!("failed to load hook trust store: {error}"))?;
        if file.schema_version != trust_schema_version() {
            return Err(format!(
                "unsupported hook trust store schema version {}",
                file.schema_version
            ));
        }
        Ok(Self { path, file })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn contains(&self, hash: &str) -> bool {
        self.file.trusted_hashes.contains(hash)
    }

    fn set(&mut self, hash: &str, trusted: bool) -> Result<(), String> {
        if trusted {
            self.file.trusted_hashes.insert(hash.to_string());
        } else {
            self.file.trusted_hashes.remove(hash);
        }
        write_json_pretty_atomic(&self.path, &self.file, AtomicWriteOptions::default())
            .map_err(|error| format!("failed to persist hook trust store: {error}"))
    }
}

pub(crate) fn set_hook_trusted(
    data_root: &Path,
    workspace_root: &Path,
    hash: &str,
    trusted: bool,
) -> Result<(), String> {
    let hash = hash.trim();
    let digest = hash.strip_prefix("sha256:").unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("hook hash must be a sha256 identifier".to_string());
    }
    let loaded = load_resolved_hooks(data_root, workspace_root)?;
    if trusted && !loaded.hooks.iter().any(|hook| hook.hash == hash) {
        return Err(
            "hook definition changed or is no longer configured; reload before trusting it"
                .to_string(),
        );
    }
    HookTrustStore::load(data_root)?.set(hash, trusted)
}
