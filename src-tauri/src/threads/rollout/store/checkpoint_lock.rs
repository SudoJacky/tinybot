use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

const CONTEXT_CHECKPOINT_LOCK_FILE: &str = "context-checkpoint.lock";

pub(crate) struct ContextCheckpointLockGuard {
    _file: File,
}

pub(crate) fn acquire_context_checkpoint_lock(
    tinybot_root: &Path,
) -> io::Result<ContextCheckpointLockGuard> {
    let lock_path = context_checkpoint_lock_path(tinybot_root);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    file.lock()?;
    Ok(ContextCheckpointLockGuard { _file: file })
}

fn context_checkpoint_lock_path(tinybot_root: &Path) -> PathBuf {
    tinybot_root
        .join("state")
        .join(CONTEXT_CHECKPOINT_LOCK_FILE)
}

#[cfg(test)]
#[path = "checkpoint_lock_tests.rs"]
mod tests;
