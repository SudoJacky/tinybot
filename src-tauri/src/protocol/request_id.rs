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
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        sync::{Arc, Mutex},
    };

    #[test]
    fn generator_returns_unique_correlation_keys_across_threads() {
        let generator = Arc::new(WorkerRequestIdGenerator::with_run_prefix("same-ms"));
        let keys = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let generator = Arc::clone(&generator);
            let keys = Arc::clone(&keys);
            handles.push(std::thread::spawn(move || {
                for _ in 0..32 {
                    let correlation = generator.next();
                    keys.lock().expect("keys mutex should lock").push((
                        correlation.id("agent-turn"),
                        correlation.trace_id("agent-turn"),
                    ));
                }
            }));
        }

        for handle in handles {
            handle.join().expect("request id worker should finish");
        }

        let keys = keys.lock().expect("keys mutex should lock");
        let ids = keys
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>();
        let trace_ids = keys
            .iter()
            .map(|(_, trace_id)| trace_id.clone())
            .collect::<BTreeSet<_>>();

        assert_eq!(keys.len(), 256);
        assert_eq!(ids.len(), keys.len());
        assert_eq!(trace_ids.len(), keys.len());
    }
}
