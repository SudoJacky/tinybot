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

    pub fn suffix(&self) -> &str {
        &self.suffix
    }
}

#[cfg(test)]
#[derive(Debug)]
pub struct WorkerRequestIdGenerator {
    run_prefix: String,
    next_sequence: AtomicU64,
}

#[cfg(test)]
impl WorkerRequestIdGenerator {
    pub fn with_run_prefix(run_prefix: impl Into<String>) -> Self {
        Self {
            run_prefix: run_prefix.into(),
            next_sequence: AtomicU64::new(1),
        }
    }

    pub fn next(&self) -> WorkerRequestCorrelation {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        WorkerRequestCorrelation::from_suffix(format!("{}-{sequence}", self.run_prefix))
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
