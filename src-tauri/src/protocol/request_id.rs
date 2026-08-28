use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};

static NEXT_WORKER_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WORKER_REQUEST_RUN_PREFIX: OnceLock<String> = OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRequestCorrelation {
    suffix: String,
}

impl WorkerRequestCorrelation {
    pub fn from_suffix(suffix: impl Into<String>) -> Self {
        Self {
            suffix: suffix.into(),
        }
    }

    pub fn id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.suffix)
    }

    pub fn trace_id(&self, prefix: &str) -> String {
        format!("trace-{prefix}-{}", self.suffix)
    }
}

pub fn next_worker_request_correlation() -> WorkerRequestCorrelation {
    let sequence = NEXT_WORKER_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    WorkerRequestCorrelation::from_suffix(format!("{}-{sequence}", worker_request_run_prefix()))
}

fn worker_request_run_prefix() -> &'static str {
    WORKER_REQUEST_RUN_PREFIX
        .get_or_init(|| {
            let now_nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            format!("{}-{now_nanos}", std::process::id())
        })
        .as_str()
}

#[cfg(test)]
#[path = "request_id_tests.rs"]
mod tests;
