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
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use std::time::Instant;

    const CHILD_ROOT_ENV: &str = "TINYBOT_CONTEXT_CHECKPOINT_LOCK_TEST_ROOT";
    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn context_checkpoint_file_lock_serializes_independent_handles() {
        let root = std::env::temp_dir().join(format!(
            "tinybot-context-checkpoint-lock-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let first = acquire_context_checkpoint_lock(&root).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let second_root = root.clone();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let second = acquire_context_checkpoint_lock(&second_root).unwrap();
            acquired_tx.send(()).unwrap();
            second
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        drop(first);
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(waiter.join().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn context_checkpoint_file_lock_serializes_processes() {
        let root = test_root("process");
        let started_path = root.join("child-started");
        let acquired_path = root.join("child-acquired");
        let first = acquire_context_checkpoint_lock(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("context_checkpoint_lock::tests::context_checkpoint_lock_child")
            .arg("--nocapture")
            .env(CHILD_ROOT_ENV, &root)
            .spawn()
            .unwrap();

        wait_for_path(&started_path, Duration::from_secs(5));
        assert!(!acquired_path.exists());
        drop(first);
        let status = child.wait().unwrap();
        assert!(status.success());
        assert!(acquired_path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn context_checkpoint_lock_child() {
        let Some(root) = std::env::var_os(CHILD_ROOT_ENV).map(PathBuf::from) else {
            return;
        };
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("child-started"), b"started").unwrap();
        let _guard = acquire_context_checkpoint_lock(&root).unwrap();
        std::fs::write(root.join("child-acquired"), b"acquired").unwrap();
    }

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tinybot-context-checkpoint-lock-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn wait_for_path(path: &Path, timeout: Duration) {
        let started = Instant::now();
        while !path.exists() {
            assert!(
                started.elapsed() < timeout,
                "timed out waiting for {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
